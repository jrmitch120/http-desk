//! A rejected certificate behind a proxy. Its own test binary, because it sets
//! the proxy environment variables, which every send in the process reads.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use httpdesk_core::env::SslConfig;
use httpdesk_core::exec::{execute, prepare, ExecSettings};
use httpdesk_core::parse;
use httpdesk_core::vars::Resolver;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// An HTTPS server presenting a self-signed certificate, counting the TCP
/// connections it accepts.
async fn self_signed_server(accepted: Arc<AtomicUsize>) -> std::net::SocketAddr {
    let key = rcgen::KeyPair::generate().unwrap();
    let params = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap();
    let cert = params.self_signed(&key).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()))
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            accepted.fetch_add(1, Ordering::SeqCst);
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let _ = acceptor.accept(stream).await;
            });
        }
    });
    addr
}

/// A minimal HTTP CONNECT proxy: reads the CONNECT request, answers 200 and
/// relays bytes both ways.
async fn connect_proxy() -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if client.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head);
                let target = head.split_whitespace().nth(1).unwrap_or_default().to_string();
                let Ok(mut upstream) = tokio::net::TcpStream::connect(target).await else { return };
                let _ = client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    addr
}

#[tokio::test]
async fn behind_a_proxy_a_rejected_certificate_is_not_fetched_again_directly() {
    let accepted = Arc::new(AtomicUsize::new(0));
    let server = self_signed_server(accepted.clone()).await;
    let proxy = connect_proxy().await;
    for name in ["NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "https_proxy"] {
        std::env::remove_var(name);
    }
    std::env::set_var("HTTPS_PROXY", format!("http://{proxy}"));

    let settings = ExecSettings::default();
    let req = parse(&format!("GET https://{server}/x\n")).requests.remove(0);
    let prepared = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &settings).unwrap();
    let Err(err) = execute(prepared, &settings, &SslConfig::default()).await else { panic!("the send succeeded") };

    let r = serde_json::to_value(&err).unwrap();
    assert_eq!(r["kind"], "tls", "{r}");
    // The only connection is the proxied one: the probe, which would connect
    // straight to the server (and say "selfSigned"), was skipped.
    assert_eq!(accepted.load(Ordering::SeqCst), 1);
    assert_ne!(r["details"]["reason"], "selfSigned", "{r}");

    // NO_PROXY exempts the host, as it does for reqwest: then the send goes
    // direct, and so does the probe.
    std::env::set_var("NO_PROXY", "127.0.0.1");
    let prepared = prepare(&req, &Resolver::new(HashMap::new()), Path::new("."), &settings).unwrap();
    let Err(err) = execute(prepared, &settings, &SslConfig::default()).await else { panic!("the send succeeded") };
    let r = serde_json::to_value(&err).unwrap();
    assert_eq!(r["details"]["reason"], "selfSigned", "{r}");
    assert_eq!(accepted.load(Ordering::SeqCst), 3);
}
