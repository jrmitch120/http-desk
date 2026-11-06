//! Cookies a response set, for the response viewer's Cookies tab. Display only:
//! nothing here sends a cookie back (a replaying jar is a separate feature).

use std::sync::{Mutex, PoisonError};

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

/// A reqwest cookie store that only writes things down. reqwest calls it for
/// every response, redirect hops included (the redirect-following layer sits
/// outside it), which is the only place a cookie set on a `302` is visible.
/// It never returns a cookie, so nothing is replayed; a `Cookie` header the
/// user wrote is sent as is.
#[derive(Debug, Default)]
pub(crate) struct Recorder(Mutex<Vec<ResponseCookie>>);

impl Recorder {
    /// Everything recorded so far, in the order it was received.
    pub(crate) fn take(&self) -> Vec<ResponseCookie> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

impl reqwest::cookie::CookieStore for Recorder {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &url::Url) {
        let mut list = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        list.extend(headers.map(|h| parse_set_cookie(&String::from_utf8_lossy(h.as_bytes()), url.as_str())));
    }

    fn cookies(&self, _url: &url::Url) -> Option<HeaderValue> {
        None
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
