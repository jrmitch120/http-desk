//! Runs: sending a selection of requests in order with the Session carried from
//! each to the next (GLOSSARY "Run"). Each request goes through [`send::send`], the
//! same flow as a single send.
//!
//! A request in a run **fails** on a network error, a script error, a failed test or
//! assert, or a blocked send. An HTTP error status alone is not a failure. A failure
//! doesn't stop the run unless it's asked to stop on the first one.
//!
//! When it ends, a run reports each of its requests ([`RunReport`]), which [`export`]
//! turns into JSON or JUnit XML.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::exec::{ExecError, HttpResponse};
use crate::send::{self, Outgoing, SendContext, Sent};

pub mod export;
mod report;

use report::Secrets;
pub use report::{Failure, Outcome, Reason, RequestReport};

/// What a run reports when it ends: whether it was stopped, and each of its requests
/// in order, those it never reached included.
#[derive(Debug, Clone)]
pub struct RunReport {
    pub cancelled: bool,
    pub requests: Vec<RequestReport>,
}

/// What a run reports about one of its requests, in this order: `Sending`, then one of
/// the others. A request the run never reached reports nothing.
pub enum RunEvent {
    /// It's being sent.
    Sending,
    /// It got a response; `failed` when a test or assert failed or a script errored.
    Sent { sent: Box<Sent>, failed: bool },
    /// It got no response: it was blocked or the network failed. Always a failure.
    Failed(ExecError),
    /// The run was stopped while it was being sent.
    Cancelled,
}

/// Whether a request that got `response` failed: a test or assert failed, or a
/// script errored (reported as a failed test). Its status doesn't count.
pub fn failed(response: &HttpResponse) -> bool {
    response.tests.iter().any(|t| !t.passed)
}

/// Stops a run, including the request in flight. Clones share the signal.
#[derive(Clone, Default)]
pub struct Cancel(Arc<CancelState>);

#[derive(Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancel {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once the run is cancelled.
    async fn cancelled(&self) {
        loop {
            // Created before checking, so a cancel in between still wakes it.
            let notified = self.0.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// How a run goes.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunOptions {
    /// How long to wait between one request's end and the next one's start (for
    /// rate limits). Stop doesn't wait for it.
    pub delay: Duration,
    /// End the run after the first request that fails; the rest aren't sent.
    pub stop_on_failure: bool,
}

/// Sends `requests` in order in `ctx`, reporting each one's progress to `on_event`
/// with its index. Stops when `cancel` fires, the request in flight or the delay
/// included, or (with `options.stop_on_failure`) after a request fails. Returns
/// what happened to each request.
pub async fn run(
    ctx: &SendContext,
    requests: Vec<Outgoing>,
    options: RunOptions,
    cancel: &Cancel,
    mut on_event: impl FnMut(usize, RunEvent),
) -> RunReport {
    let root = ctx.root.as_deref();
    let mut reports: Vec<RequestReport> = requests.iter().map(|out| RequestReport::not_run(root, out)).collect();
    for (index, out) in requests.into_iter().enumerate() {
        if index > 0 && !options.delay.is_zero() {
            tokio::select! {
                _ = tokio::time::sleep(options.delay) => {}
                _ = cancel.cancelled() => return RunReport { cancelled: true, requests: reports },
            }
        }
        if cancel.is_cancelled() {
            return RunReport { cancelled: true, requests: reports };
        }
        on_event(index, RunEvent::Sending);
        let secrets = Secrets::new(send::secret_values(root, ctx.environment.as_deref(), &out));
        let result = tokio::select! {
            result = send::send(ctx, out, |_| {}) => result,
            _ = cancel.cancelled() => {
                reports[index].cancelled();
                on_event(index, RunEvent::Cancelled);
                return RunReport { cancelled: true, requests: reports };
            }
        };
        let event = match result {
            Ok(sent) => {
                let failed = failed(&sent.response);
                reports[index].sent(&sent.response, failed, &secrets);
                RunEvent::Sent { sent: Box::new(sent), failed }
            }
            Err(e) => {
                reports[index].failed(&e, &secrets);
                RunEvent::Failed(e)
            }
        };
        let failed = matches!(event, RunEvent::Sent { failed: true, .. } | RunEvent::Failed(_));
        on_event(index, event);
        if failed && options.stop_on_failure {
            break;
        }
    }
    RunReport { cancelled: cancel.is_cancelled(), requests: reports }
}
