//! Cookies: the ones a response set, for the response viewer's Cookies tab, and
//! the Session's cookie jar, which keeps them and sends them on later requests.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};

/// One `Set-Cookie` header, parsed into the attributes people debug a login
/// flow with. A header that doesn't parse is kept with [`parse_error`] set and
/// the attributes empty, so it still shows up (as [`raw`]) instead of vanishing.
///
/// [`parse_error`]: ResponseCookie::parse_error
/// [`raw`]: ResponseCookie::raw
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseCookie {
    pub name: String,
    pub value: String,
    /// The `Domain` attribute without a leading dot; absent means host-only.
    pub domain: Option<String>,
    pub path: Option<String>,
    /// The `Expires` attribute as RFC 3339 UTC (`2026-11-07T07:00:00Z`).
    pub expires: Option<String>,
    /// The `Max-Age` attribute in seconds. Kept apart from `expires` because a
    /// cookie can carry both and `Max-Age` wins; negative values read as 0.
    pub max_age: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
    /// `Strict`, `Lax` or `None`; absent when missing or not one of those.
    pub same_site: Option<String>,
    /// The URL of the response that set it (a redirect hop or the final one).
    pub url: String,
    /// The header value as received.
    pub raw: String,
    /// Why the header couldn't be read as a cookie, if it couldn't.
    pub parse_error: Option<String>,
}

/// Parses one `Set-Cookie` value received from `url`.
pub fn parse_set_cookie(raw: &str, url: &str) -> ResponseCookie {
    let mut out = ResponseCookie {
        name: String::new(),
        value: String::new(),
        domain: None,
        path: None,
        expires: None,
        max_age: None,
        secure: false,
        http_only: false,
        same_site: None,
        url: url.to_string(),
        raw: raw.to_string(),
        parse_error: None,
    };
    match cookie::Cookie::parse(raw) {
        Ok(c) => {
            out.name = c.name().to_string();
            out.value = c.value().to_string();
            out.domain = c.domain().map(str::to_string);
            out.path = c.path().map(str::to_string);
            out.expires = c
                .expires_datetime()
                .and_then(|t| chrono::DateTime::from_timestamp(t.unix_timestamp(), 0))
                .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
            out.max_age = c.max_age().map(|d| d.whole_seconds());
            out.secure = c.secure().unwrap_or(false);
            out.http_only = c.http_only().unwrap_or(false);
            out.same_site = c.same_site().map(|s| s.to_string());
        }
        Err(e) => out.parse_error = Some(e.to_string()),
    }
    out
}

/// The Session's cookie jar: the cookies responses have set, sent on later
/// requests they match, by RFC 6265's domain, path and expiry rules. A `Secure`
/// cookie goes over https only. The jar isn't scoped by environment; domain
/// matching keeps hosts apart. It's never written to disk.
///
/// Every send that belongs to a Session uses its jar, whichever pooled client it
/// goes out on (see [`crate::exec::execute_on`]). Cloning shares the jar.
#[derive(Debug, Clone, Default)]
pub struct CookieJar(Arc<Mutex<cookie_store::CookieStore>>);

/// A cookie in a [`CookieJar`]. A cookie is identified by its `domain`, `path`
/// and `name`: a response setting one with the same three replaces it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCookie {
    pub name: String,
    pub value: String,
    /// The host it is sent to, without a leading dot; its subdomains too unless
    /// `host_only`.
    pub domain: String,
    /// Set without a `Domain` attribute, so sent to exactly `domain`.
    pub host_only: bool,
    /// The path it is sent under: its `Path` attribute, or else the directory of
    /// the URL that set it.
    pub path: String,
    /// When it expires, as RFC 3339 UTC, from `Max-Age` or `Expires`; absent for a
    /// cookie that lasts until the Session ends.
    pub expires: Option<String>,
    pub secure: bool,
    pub http_only: bool,
    /// `Strict`, `Lax` or `None`; absent when missing or not one of those.
    pub same_site: Option<String>,
}

impl CookieJar {
    /// The unexpired cookies, by domain, then path, then name.
    pub fn list(&self) -> Vec<StoredCookie> {
        let mut out: Vec<StoredCookie> = self.lock().iter_unexpired().map(stored).collect();
        out.sort_by(|a, b| (&a.domain, &a.path, &a.name).cmp(&(&b.domain, &b.path, &b.name)));
        out
    }

    /// Deletes the cookie with this domain, path and name (as [`list`] gives
    /// them). False if there was none.
    ///
    /// [`list`]: CookieJar::list
    pub fn remove(&self, domain: &str, path: &str, name: &str) -> bool {
        self.lock().remove(domain, path, name).is_some()
    }

    /// Deletes every cookie.
    pub fn clear(&self) {
        self.lock().clear();
    }

    /// The `Cookie` header value for a request to `url`, if any cookie matches:
    /// longer paths first, then in the order they were first set.
    fn header(&self, url: &url::Url) -> Option<String> {
        let store = self.lock();
        let mut matching = store.matches(url);
        // cookie_store counts http://localhost as secure, as browsers do; the
        // JetBrains client and REST Client don't, and neither does HttpDesk.
        matching.retain(|c| url.scheme() == "https" || !c.secure().unwrap_or(false));
        matching.sort_by_key(|c| std::cmp::Reverse(String::from(&c.path).len()));
        let pairs: Vec<String> = matching.iter().map(|c| format!("{}={}", c.name(), c.value())).collect();
        (!pairs.is_empty()).then(|| pairs.join("; "))
    }

    fn store(&self, cookies: Vec<cookie::Cookie<'static>>, url: &url::Url) {
        self.lock().store_response_cookies(cookies.into_iter(), url);
    }

    fn lock(&self) -> MutexGuard<'_, cookie_store::CookieStore> {
        lock(&self.0)
    }
}

fn stored(c: &cookie_store::Cookie<'static>) -> StoredCookie {
    let (domain, host_only) = match &c.domain {
        cookie_store::CookieDomain::HostOnly(h) => (h.clone(), true),
        other => (String::from(other), false),
    };
    let expires = match &c.expires {
        cookie_store::CookieExpiration::AtUtc(t) => chrono::DateTime::from_timestamp(t.unix_timestamp(), 0)
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        cookie_store::CookieExpiration::SessionEnd => None,
    };
    StoredCookie {
        name: c.name().to_string(),
        value: c.value().to_string(),
        domain,
        host_only,
        path: String::from(&c.path),
        expires,
        secure: c.secure().unwrap_or(false),
        http_only: c.http_only().unwrap_or(false),
        same_site: c.same_site().map(|s| s.to_string()),
    }
}

/// The cookie store reqwest gets for one client. Per send it records every
/// `Set-Cookie` received, for the Cookies tab: reqwest calls it for every
/// response, redirect hops included (the redirect-following layer sits outside
/// it), which is the only place a cookie set on a `302` is visible. It also
/// keeps them in, and sends them from, the jar the send uses, if any; with none
/// it sends and stores nothing. A `Cookie` header the user wrote is sent as is,
/// instead of the jar's: reqwest asks the store only when there is none.
#[derive(Debug, Default)]
pub(crate) struct Recorder {
    received: Mutex<Vec<ResponseCookie>>,
    /// The `Cookie` header the jar gave the latest hop.
    sent: Mutex<Option<String>>,
    jar: Mutex<Option<CookieJar>>,
}

impl Recorder {
    /// Starts a send that uses `jar` (or none), forgetting anything an earlier
    /// send on this client left behind.
    pub(crate) fn start(&self, jar: Option<CookieJar>) {
        lock(&self.received).clear();
        *lock(&self.sent) = None;
        *lock(&self.jar) = jar;
    }

    /// Ends the send: the cookies its responses set, in the order received, and
    /// the `Cookie` header the jar gave its final hop. Also called when a send
    /// fails or is dropped, so an idle client holds on to no Session's jar.
    pub(crate) fn finish(&self) -> (Vec<ResponseCookie>, Option<String>) {
        *lock(&self.jar) = None;
        (std::mem::take(&mut *lock(&self.received)), lock(&self.sent).take())
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl reqwest::cookie::CookieStore for Recorder {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &url::Url) {
        let raw: Vec<String> = headers.map(|h| String::from_utf8_lossy(h.as_bytes()).into_owned()).collect();
        lock(&self.received).extend(raw.iter().map(|r| parse_set_cookie(r, url.as_str())));
        if let Some(jar) = lock(&self.jar).as_ref() {
            jar.store(raw.into_iter().filter_map(|r| cookie::Cookie::parse(r).ok()).collect(), url);
        }
    }

    fn cookies(&self, url: &url::Url) -> Option<HeaderValue> {
        let header = lock(&self.jar).as_ref().and_then(|jar| jar.header(url));
        let value = header.as_ref().and_then(|h| HeaderValue::from_bytes(h.as_bytes()).ok());
        *lock(&self.sent) = header.filter(|_| value.is_some());
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://example.com/login";

    #[test]
    fn a_cookie_with_every_attribute_parses_into_its_fields() {
        let c = parse_set_cookie(
            "sid=abc123; Domain=.example.com; Path=/app; Expires=Sat, 07 Nov 2026 07:00:00 GMT; Secure; HttpOnly; SameSite=Strict",
            URL,
        );
        assert_eq!((c.name.as_str(), c.value.as_str()), ("sid", "abc123"));
        assert_eq!(c.domain.as_deref(), Some("example.com"));
        assert_eq!(c.path.as_deref(), Some("/app"));
        assert_eq!(c.expires.as_deref(), Some("2026-11-07T07:00:00Z"));
        assert_eq!(c.max_age, None);
        assert!(c.secure && c.http_only);
        assert_eq!(c.same_site.as_deref(), Some("Strict"));
        assert_eq!(c.url, URL);
        assert_eq!(c.parse_error, None);
    }

    #[test]
    fn max_age_and_expires_land_in_separate_fields() {
        let c = parse_set_cookie("a=1; Max-Age=3600", URL);
        assert_eq!((c.max_age, c.expires.as_deref()), (Some(3600), None));

        let c = parse_set_cookie("a=1; Max-Age=60; Expires=Thu, 01 Jan 2026 00:00:00 GMT", URL);
        assert_eq!((c.max_age, c.expires.as_deref()), (Some(60), Some("2026-01-01T00:00:00Z")));

        // RFC 6265 5.2.2: a negative Max-Age means "expire now".
        assert_eq!(parse_set_cookie("a=1; Max-Age=-5", URL).max_age, Some(0));
        // Not a number: ignored, like a browser does.
        assert_eq!(parse_set_cookie("a=1; Max-Age=soon", URL).max_age, None);
    }

    #[test]
    fn same_site_values_are_read_case_insensitively_and_unknown_ones_dropped() {
        let same_site = |v: &str| parse_set_cookie(&format!("a=1; SameSite={v}"), URL).same_site;
        assert_eq!(same_site("strict").as_deref(), Some("Strict"));
        assert_eq!(same_site("Lax").as_deref(), Some("Lax"));
        assert_eq!(same_site("NONE").as_deref(), Some("None"));
        assert_eq!(same_site("Bogus"), None);
    }

    #[test]
    fn missing_attributes_are_absent_or_false() {
        let c = parse_set_cookie("theme=dark", URL);
        assert_eq!((c.name.as_str(), c.value.as_str()), ("theme", "dark"));
        assert_eq!((c.domain, c.path, c.expires, c.max_age, c.same_site), (None, None, None, None, None));
        assert!(!c.secure && !c.http_only);
        assert_eq!(c.raw, "theme=dark");
    }

    #[test]
    fn an_empty_value_is_a_cookie_not_an_error() {
        let c = parse_set_cookie("sid=; Max-Age=0", URL);
        assert_eq!((c.name.as_str(), c.value.as_str(), c.parse_error), ("sid", "", None));
    }

    #[test]
    fn a_malformed_set_cookie_is_kept_raw_with_the_reason() {
        for raw in ["no equals sign here", "=value-without-name; Path=/"] {
            let c = parse_set_cookie(raw, URL);
            assert_eq!(c.raw, raw);
            assert_eq!(c.url, URL);
            assert!(c.parse_error.is_some(), "{raw}");
            assert_eq!((c.name.as_str(), c.value.as_str()), ("", ""));
        }
    }
}
