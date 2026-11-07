//! Phase timing for the Timing tab. reqwest doesn't report how long DNS or the
//! connection took, so the client is built with two hooks that record it: a DNS
//! resolver wrapper and a connector layer (which covers DNS, TCP and TLS). A
//! redirect policy wrapper marks where each hop starts, so the phases describe
//! the final request after redirects. Everything is recorded with [`Instant`]s
//! into a [`Recorder`] shared by the hooks, then turned into [`Timings`] once
//! the body has arrived. The redirect marks also keep each hop's status and
//! URLs ([`Hop`]), which the Request tab's reconstruction of the final request
//! is built from.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::{Deserialize, Serialize};

/// How long each phase of the final request took, in milliseconds. A phase
/// that didn't happen or wasn't measured is `None` (serialised as absent, never
/// zero): DNS and connect on a reused connection, DNS for an IP-literal host.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    /// Looking the host up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns: Option<f64>,
    /// TCP connect plus the TLS handshake for https (one figure: telling them
    /// apart would need a connector of our own in place of reqwest's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect: Option<f64>,
    /// From the connection being ready (or the hop starting, when reused) to
    /// the response headers: sending the request and waiting for the server.
    pub ttfb: f64,
    /// From the response headers to the end of the body.
    pub download: f64,
    /// Whether the final request went over a connection that was already open.
    pub reused: bool,
    /// How many redirects were followed before the final response.
    pub redirects: usize,
}

#[derive(Debug, Clone)]
enum Event {
    Dns(Instant, Instant),
    Connect(Instant, Instant),
    Redirect(Instant, Hop),
}

/// One redirect that was followed: the status that asked for it, the URL
/// that answered with it, and the URL it led to.
#[derive(Debug, Clone)]
pub(crate) struct Hop {
    pub status: u16,
    pub from: url::Url,
    pub to: url::Url,
}

/// The events of the request in flight, written by the client's hooks. A
/// client times one request at a time: [`Recorder::reset`] starts afresh, so
/// concurrent requests on one client would mix their phases.
#[derive(Debug, Clone, Default)]
pub(crate) struct Recorder(Arc<Mutex<Vec<Event>>>);

impl Recorder {
    fn push(&self, e: Event) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).push(e);
    }

    /// Forgets the previous request's events.
    pub(crate) fn reset(&self) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    /// A DNS resolver that times each lookup.
    pub(crate) fn resolver(&self) -> Arc<TimedResolver> {
        Arc::new(TimedResolver(self.clone()))
    }

    /// A connector layer that times each new connection.
    pub(crate) fn layer(&self) -> ConnectTiming {
        ConnectTiming(self.clone())
    }

    /// Wraps a redirect policy so each followed hop is marked.
    pub(crate) fn redirects(&self, policy: reqwest::redirect::Policy) -> reqwest::redirect::Policy {
        let rec = self.clone();
        reqwest::redirect::Policy::custom(move |attempt| {
            // Marked before the policy decides; if it refuses, the send fails
            // and nothing reads the mark.
            if let Some(from) = attempt.previous().last() {
                let hop = Hop { status: attempt.status().as_u16(), from: from.clone(), to: attempt.url().clone() };
                rec.push(Event::Redirect(Instant::now(), hop));
            }
            policy.redirect(attempt)
        })
    }

    /// The redirects the request in flight followed, in order.
    pub(crate) fn hops(&self) -> Vec<Hop> {
        let events = self.0.lock().unwrap_or_else(|p| p.into_inner());
        events
            .iter()
            .filter_map(|e| match e {
                Event::Redirect(_, hop) => Some(hop.clone()),
                _ => None,
            })
            .collect()
    }

    /// The phases of the final hop. `start` is when the send began, `headers`
    /// when the final response's headers arrived, `end` when its body ended.
    pub(crate) fn timings(&self, start: Instant, headers: Instant, end: Instant) -> Timings {
        let events = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        let redirects = events.iter().filter(|e| matches!(e, Event::Redirect(..))).count();
        let hop_start = events
            .iter()
            .rev()
            .find_map(|e| match e {
                Event::Redirect(at, _) => Some(*at),
                _ => None,
            })
            .unwrap_or(start);
        // A connection opened after the final hop started is the one it used;
        // none means the hop went over one already open.
        let conn = events.iter().rev().find_map(|e| match e {
            Event::Connect(a, b) if *a >= hop_start => Some((*a, *b)),
            _ => None,
        });
        let download = ms(end.saturating_duration_since(headers));
        let Some((opened, ready)) = conn else {
            return Timings {
                ttfb: ms(headers.saturating_duration_since(hop_start)),
                download,
                reused: true,
                redirects,
                ..Timings::default()
            };
        };
        // The lookup runs inside the connector, so it falls within the connection's span.
        let dns = events.iter().rev().find_map(|e| match e {
            Event::Dns(s, f) if *s >= opened && *f <= ready => Some(*f - *s),
            _ => None,
        });
        Timings {
            dns: dns.map(ms),
            connect: Some(ms((ready - opened).saturating_sub(dns.unwrap_or_default()))),
            ttfb: ms(headers.saturating_duration_since(ready)),
            download,
            reused: false,
            redirects,
        }
    }
}

/// System DNS (getaddrinfo on the blocking pool, as reqwest's default does),
/// timed. reqwest's own resolver isn't public, so it can't be wrapped.
#[derive(Debug)]
pub(crate) struct TimedResolver(Recorder);

impl Resolve for TimedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let rec = self.0.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let began = Instant::now();
            let found = tokio::net::lookup_host((host.as_str(), 0)).await;
            rec.push(Event::Dns(began, Instant::now()));
            let addrs: Vec<SocketAddr> = found?.collect();
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// Connector layer: times the inner connector (DNS, TCP and TLS). It is only
/// called when the pool has no open connection to reuse.
#[derive(Debug, Clone)]
pub(crate) struct ConnectTiming(Recorder);

impl<S> tower_layer::Layer<S> for ConnectTiming {
    type Service = TimedConnect<S>;

    fn layer(&self, inner: S) -> TimedConnect<S> {
        TimedConnect { inner, rec: self.0.clone() }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct TimedConnect<S> {
    inner: S,
    rec: Recorder,
}

impl<S, R> tower_service::Service<R> for TimedConnect<S>
where
    S: tower_service::Service<R>,
    S::Future: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<S::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: R) -> Self::Future {
        let rec = self.rec.clone();
        let began = Instant::now();
        let connecting = self.inner.call(req);
        Box::pin(async move {
            let conn = connecting.await;
            if conn.is_ok() {
                rec.push(Event::Connect(began, Instant::now()));
            }
            conn
        })
    }
}
