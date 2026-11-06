//! Receiving a response body: counting the bytes on the wire, undoing
//! `Content-Encoding`, and applying the size limit to the decoded bytes.
//!
//! reqwest's own decompression is off (see `build_client`) so that the raw
//! bytes pass through here first. [`BodyReader::push`] is the one place raw
//! bytes are counted; anything that reports wire bytes (the transferred size,
//! a progress count) should read that count rather than keep its own.

use std::io::{self, Write};

/// A decoder for one `Content-Encoding` token.
enum Stage {
    Gzip(flate2::write::GzDecoder<Vec<u8>>),
    /// HTTP "deflate" is zlib-wrapped (RFC 9110 sec. 8.4.1.2).
    Deflate(flate2::write::ZlibDecoder<Vec<u8>>),
    Brotli(Box<brotli_decompressor::DecompressorWriter<Vec<u8>>>),
    Zstd(zstd::stream::write::Decoder<'static, Vec<u8>>),
}

impl Stage {
    /// The decoder for a (lowercase) encoding token, or `None` if we can't decode it.
    fn for_token(token: &str) -> Option<io::Result<Stage>> {
        Some(Ok(match token {
            "gzip" | "x-gzip" => Stage::Gzip(flate2::write::GzDecoder::new(Vec::new())),
            "deflate" => Stage::Deflate(flate2::write::ZlibDecoder::new(Vec::new())),
            "br" => Stage::Brotli(Box::new(brotli_decompressor::DecompressorWriter::new(Vec::new(), 16 * 1024))),
            "zstd" => return Some(zstd::stream::write::Decoder::new(Vec::new()).map(Stage::Zstd)),
            _ => return None,
        }))
    }

    /// Feeds encoded bytes and returns whatever decoded output is ready.
    fn write(&mut self, input: &[u8]) -> io::Result<Vec<u8>> {
        let out = match self {
            Stage::Gzip(d) => d.write_all(input).and_then(|_| d.flush()).map(|_| d.get_mut()),
            Stage::Deflate(d) => d.write_all(input).and_then(|_| d.flush()).map(|_| d.get_mut()),
            Stage::Brotli(d) => d.write_all(input).and_then(|_| d.flush()).map(|_| d.get_mut()),
            Stage::Zstd(d) => d.write_all(input).and_then(|_| d.flush()).map(|_| d.get_mut()),
        }?;
        Ok(std::mem::take(out))
    }

    /// Ends the stream, failing if it was cut short, and returns the remaining output.
    fn finish(self) -> io::Result<Vec<u8>> {
        match self {
            Stage::Gzip(d) => d.finish(),
            Stage::Deflate(d) => d.finish(),
            Stage::Brotli(mut d) => {
                d.close()?;
                d.into_inner().map_err(|_| io::Error::new(io::ErrorKind::UnexpectedEof, "incomplete brotli stream"))
            }
            Stage::Zstd(d) => d.finish(),
        }
    }
}

/// What [`BodyReader::finish`] hands back.
pub(super) struct ReceivedBody {
    /// Decoded bytes (or the raw bytes when the body couldn't be decoded), cut at the limit.
    pub bytes: Vec<u8>,
    /// Raw body bytes received on the wire.
    pub transferred: usize,
    pub truncated: bool,
    /// Why the body couldn't be decoded, as a warning; `bytes` are then as received.
    pub decode_failure: Option<String>,
}

/// Accumulates a response body chunk by chunk as it arrives.
pub(super) struct BodyReader {
    /// Decoders in the order they apply: the reverse of the header's listing.
    stages: Vec<Stage>,
    /// The encoding token a stage is decoding, for error messages.
    names: Vec<String>,
    transferred: usize,
    body: Vec<u8>,
    /// The raw bytes up to the limit, kept while decoding so a body that turns
    /// out not to decode can still be shown as received.
    raw: Vec<u8>,
    raw_truncated: bool,
    limit: usize,
    truncated: bool,
    decode_failure: Option<String>,
}

impl BodyReader {
    /// A reader for a response with the given `Content-Encoding` header. The
    /// second value is a warning when the encoding can't be decoded, in which
    /// case the bytes are kept as received.
    pub fn new(content_encoding: Option<&str>, limit: usize) -> (BodyReader, Option<String>) {
        let mut reader = BodyReader {
            stages: Vec::new(),
            names: Vec::new(),
            transferred: 0,
            body: Vec::new(),
            raw: Vec::new(),
            raw_truncated: false,
            limit,
            truncated: false,
            decode_failure: None,
        };
        let tokens: Vec<String> = content_encoding
            .unwrap_or("")
            .split(',')
            .map(|t| t.trim().to_ascii_lowercase())
            .filter(|t| !t.is_empty() && t != "identity")
            .collect();
        let mut stages = Vec::new();
        for token in tokens.iter().rev() {
            match Stage::for_token(token) {
                Some(Ok(stage)) => stages.push(stage),
                // Setting up a decoder only fails on allocation; treat it like an unknown encoding.
                Some(Err(_)) | None => {
                    let shown = content_encoding.unwrap_or_default().trim();
                    return (
                        reader,
                        Some(format!("Content-Encoding {shown} isn't supported; showing the bytes as received")),
                    );
                }
            }
        }
        reader.stages = stages;
        reader.names = tokens.into_iter().rev().collect();
        (reader, None)
    }

    /// Takes one chunk as it came off the wire. Returns `false` once the
    /// body has hit the limit and the rest needn't be read.
    pub fn push(&mut self, raw: &[u8]) -> bool {
        self.transferred += raw.len();
        if self.stages.is_empty() {
            return self.append(raw);
        }
        if !self.raw_truncated {
            let room = self.limit - self.raw.len();
            self.raw.extend_from_slice(&raw[..raw.len().min(room)]);
            self.raw_truncated = raw.len() > room;
        }
        let mut data = raw.to_vec();
        for i in 0..self.stages.len() {
            match self.stages[i].write(&data) {
                Ok(out) => data = out,
                Err(e) => return self.fail(i, &e),
            }
        }
        self.append(&data)
    }

    /// Raw body bytes received on the wire so far (what progress reports).
    pub fn transferred(&self) -> usize {
        self.transferred
    }

    /// Ends the body, flushing the decoders.
    pub fn finish(mut self) -> ReceivedBody {
        // A cut-off body would fail to finish; and an empty one (HEAD, 204) has nothing to decode.
        if !self.truncated && self.transferred > 0 {
            let mut stages = std::mem::take(&mut self.stages);
            let mut i = 0;
            'stages: while !stages.is_empty() {
                let mut data = match stages.remove(0).finish() {
                    Ok(data) => data,
                    Err(e) => {
                        self.fail(i, &e);
                        break;
                    }
                };
                for (j, next) in stages.iter_mut().enumerate() {
                    match next.write(&data) {
                        Ok(out) => data = out,
                        Err(e) => {
                            self.fail(i + 1 + j, &e);
                            break 'stages;
                        }
                    }
                }
                if !self.append(&data) {
                    break;
                }
                i += 1;
            }
        }
        ReceivedBody {
            bytes: self.body,
            transferred: self.transferred,
            truncated: self.truncated,
            decode_failure: self.decode_failure,
        }
    }

    /// Adds decoded bytes up to the limit; `false` once the limit is reached.
    fn append(&mut self, data: &[u8]) -> bool {
        let room = self.limit - self.body.len();
        if data.len() > room {
            self.body.extend_from_slice(&data[..room]);
            self.truncated = true;
            return false;
        }
        self.body.extend_from_slice(data);
        true
    }

    /// Gives up decoding: the body becomes the raw bytes received so far
    /// (later chunks are appended as they come), with a warning saying why.
    /// Returns whether to keep reading, as [`Self::push`] does.
    fn fail(&mut self, stage: usize, e: &io::Error) -> bool {
        self.decode_failure =
            Some(format!("Couldn't decode the {} body ({e}); showing the bytes as received", self.names[stage]));
        self.stages.clear();
        self.body = std::mem::take(&mut self.raw);
        self.truncated = self.raw_truncated;
        !self.truncated
    }
}
