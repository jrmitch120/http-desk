//! Works out why a server's certificate was rejected when the verifier's error
//! doesn't say. The platform verifiers differ: macOS reports a self-signed or
//! expired certificate as an opaque `Other` code, webpki as `UnknownIssuer`.
//! So after such a failure we fetch the certificate once more with a handshake
//! that records it and then aborts, and judge it ourselves.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

use crate::exec::TlsReason;

/// Why `host:port`'s certificate is untrustworthy, when the certificate alone
/// tells: it has expired, or it's self-signed. `None` when it doesn't, or when
/// it can't be fetched within `timeout` (e.g. a proxy sits in between).
pub(crate) async fn certificate_reason(host: &str, port: u16, timeout: Duration) -> Option<TlsReason> {
    let leaf = tokio::time::timeout(timeout, fetch_certificate(host, port)).await.ok().flatten()?;
    judge(&leaf)
}

fn judge(leaf: &CertificateDer<'_>) -> Option<TlsReason> {
    let algs = provider().signature_verification_algorithms.all;
    let anchors = [webpki::anchor_from_trusted_cert(leaf).ok()?];
    let cert = webpki::EndEntityCert::try_from(leaf).ok()?;
    // With itself as the only trust anchor, a self-signed certificate verifies; an
    // expired one fails on its dates first, whoever signed it.
    let verified =
        cert.verify_for_usage(algs, &anchors, &[], UnixTime::now(), webpki::KeyUsage::server_auth(), None, None);
    match verified {
        Ok(_) => Some(TlsReason::SelfSigned),
        Err(webpki::Error::CertExpired { .. }) => Some(TlsReason::Expired),
        // E.g. a self-signed CA certificate used as the server's own.
        Err(_) if cert.issuer() == cert.subject() => Some(TlsReason::SelfSigned),
        Err(_) => None,
    }
}

fn provider() -> CryptoProvider {
    rustls::crypto::aws_lc_rs::default_provider()
}

async fn fetch_certificate(host: &str, port: u16) -> Option<CertificateDer<'static>> {
    let recorder = Arc::new(Recorder { leaf: Mutex::default(), algs: provider().signature_verification_algorithms });
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(provider()))
        .with_safe_default_protocol_versions()
        .ok()?
        .dangerous()
        .with_custom_certificate_verifier(recorder.clone())
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_string()).ok()?;
    let tcp = tokio::net::TcpStream::connect((host, port)).await.ok()?;
    // The recorder rejects every certificate, so this handshake always fails.
    let _ = tokio_rustls::TlsConnector::from(Arc::new(config)).connect(name, tcp).await;
    let leaf = recorder.leaf.lock().unwrap().take();
    leaf
}

/// Keeps the server's certificate and ends the handshake there.
#[derive(Debug)]
struct Recorder {
    leaf: Mutex<Option<CertificateDer<'static>>>,
    algs: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Recorder {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        *self.leaf.lock().unwrap() = Some(end_entity.clone().into_owned());
        Err(rustls::Error::General("certificate recorded".into()))
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("certificate recorded".into()))
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("certificate recorded".into()))
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}
