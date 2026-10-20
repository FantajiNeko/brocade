//! HTTP/1 response boundaries (RFC 9112 §6.3/§7.1), shared by socket reads and
//! parser tests. A complete length/chunk-delimited message never waits for EOF.

use super::{HttpResponse, MAX_HTTP_RESPONSE_BYTES};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, BufReader, Read},
};

#[cfg(test)]
mod tests;

pub(super) fn read_response(stream: impl Read, method: &str) -> Result<HttpResponse, String> {
    let mut reader = ResponseReader::new(stream);
    loop {
        let line = reader.line("HTTP response missing header terminator")?;
        let status = parse_status(&line)?;
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        loop {
            let line = reader.line("HTTP response missing header terminator")?;
            if line.is_empty() {
                break;
            }
            let (name, value) = parse_field(&line)?;
            // Do not let a later framing field conceal a conflicting earlier one.
            if matches!(name.as_str(), "content-length" | "transfer-encoding") {
                headers
                    .entry(name)
                    .and_modify(|old| {
                        old.push(',');
                        old.push_str(&value);
                    })
                    .or_insert(value);
            } else {
                headers.insert(name, value);
            }
        }
        if status == 101 || (method == "CONNECT" && (200..300).contains(&status)) {
            return Err("HTTP protocol upgrade/tunnel is unsupported".to_owned());
        }
        if status < 200 {
            // 100 Continue/103 Early Hints are not the final response. Their
            // bytes count against the same limit, even across buffered reads.
            continue;
        }
        let mut body = Vec::new();
        if method == "HEAD" || matches!(status, 204 | 304) {
            // Content-Length here describes a representation, not a body.
        } else if let Some(encoding) = headers.get("transfer-encoding") {
            if headers.contains_key("content-length") {
                return Err(
                    "HTTP response has conflicting Transfer-Encoding and Content-Length".to_owned(),
                );
            }
            // The client has no transfer gzip/deflate decoder. Never pretend
            // that unchunking alone decodes a stack such as gzip, chunked.
            if !encoding.trim().eq_ignore_ascii_case("chunked") {
                return Err("HTTP response has unsupported Transfer-Encoding".to_owned());
            }
            body = reader.chunked()?;
        } else if let Some(value) = headers.get("content-length") {
            let length = content_length(value)?;
            reader.append_exact(
                &mut body,
                length,
                "HTTP response ended before Content-Length",
            )?;
        } else {
            body = reader.until_eof()?;
        }
        return Ok(HttpResponse {
            status,
            body: String::from_utf8(body).map_err(|error| error.to_string())?,
            headers,
        });
    }
}

fn parse_status(line: &[u8]) -> Result<u16, String> {
    let text = std::str::from_utf8(line).map_err(|_| "HTTP response has invalid status")?;
    let mut fields = text.split_whitespace();
    if !matches!(fields.next(), Some("HTTP/1.0" | "HTTP/1.1")) {
        return Err("HTTP response has invalid version".to_owned());
    }
    let field = fields.next().ok_or("HTTP response missing status")?;
    if field.len() != 3 || !field.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("HTTP response has invalid status".to_owned());
    }
    let status = field
        .parse::<u16>()
        .map_err(|_| "HTTP response has invalid status")?;
    if !(100..600).contains(&status) {
        return Err("HTTP response has invalid status".to_owned());
    }
    Ok(status)
}

fn parse_field(line: &[u8]) -> Result<(String, String), String> {
    let colon = line
        .iter()
        .position(|&byte| byte == b':')
        .ok_or("HTTP response has invalid header field")?;
    let (name, value) = (&line[..colon], &line[colon + 1..]);
    if name.is_empty()
        || !name
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(byte))
        || value
            .iter()
            .any(|&byte| (byte < 0x20 && byte != b'\t') || byte == 0x7f)
    {
        return Err("HTTP response has invalid header field".to_owned());
    }
    Ok((
        String::from_utf8_lossy(name).to_ascii_lowercase(),
        String::from_utf8_lossy(value)
            .trim_matches([' ', '\t'])
            .to_owned(),
    ))
}

fn content_length(value: &str) -> Result<usize, String> {
    let mut length = None;
    for part in value.split(',') {
        let part = part.trim_matches([' ', '\t']);
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("HTTP response has invalid Content-Length".to_owned());
        }
        let parsed = part
            .parse::<usize>()
            .map_err(|_| "HTTP response has invalid Content-Length")?;
        if length.is_some_and(|length| length != parsed) {
            return Err("HTTP response has conflicting Content-Length values".to_owned());
        }
        length = Some(parsed);
    }
    length.ok_or_else(|| "HTTP response has invalid Content-Length".to_owned())
}

// Preserve compatibility with TLS peers that omit close_notify. Only the
// close-delimited branch may treat this as completion; exact reads and CRLF
// lines still reject a truncated length/chunked/header/trailer.
struct EofReader<R>(R);

impl<R: Read> Read for EofReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            match self.0.read(buffer) {
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(0),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => return result,
            }
        }
    }
}

struct ResponseReader<R> {
    stream: BufReader<EofReader<R>>,
    consumed: usize,
}

impl<R: Read> ResponseReader<R> {
    fn new(stream: R) -> Self {
        Self {
            stream: BufReader::new(EofReader(stream)),
            consumed: 0,
        }
    }

    fn check_length(&self, additional: usize) -> Result<(), String> {
        if additional > MAX_HTTP_RESPONSE_BYTES - self.consumed {
            return Err(format!(
                "HTTP response exceeds {MAX_HTTP_RESPONSE_BYTES} byte limit"
            ));
        }
        Ok(())
    }

    fn line(&mut self, incomplete: &str) -> Result<Vec<u8>, String> {
        let mut line = Vec::new();
        loop {
            self.check_length(1)?;
            let available = self
                .stream
                .fill_buf()
                .map_err(|error| format!("read HTTP response: {error}"))?;
            if available.is_empty() {
                return Err(incomplete.to_owned());
            }
            let end = available
                .iter()
                .position(|&byte| byte == b'\n')
                .map(|index| index + 1);
            let length = end.unwrap_or(available.len());
            if length > MAX_HTTP_RESPONSE_BYTES - self.consumed {
                return Err(format!(
                    "HTTP response exceeds {MAX_HTTP_RESPONSE_BYTES} byte limit"
                ));
            }
            line.extend_from_slice(&available[..length]);
            self.stream.consume(length);
            self.consumed += length;
            if end.is_some() {
                if !line.ends_with(b"\r\n") {
                    return Err("HTTP response line missing CRLF".to_owned());
                }
                line.truncate(line.len() - 2);
                return Ok(line);
            }
        }
    }

    fn exact(&mut self, bytes: &mut [u8], incomplete: &str) -> Result<(), String> {
        self.check_length(bytes.len())?;
        self.stream.read_exact(bytes).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                incomplete.to_owned()
            } else {
                format!("read HTTP response: {error}")
            }
        })?;
        self.consumed += bytes.len();
        Ok(())
    }

    fn append_exact(
        &mut self,
        body: &mut Vec<u8>,
        length: usize,
        incomplete: &str,
    ) -> Result<(), String> {
        self.check_length(length)?;
        let start = body.len();
        let end = start
            .checked_add(length)
            .ok_or("HTTP response length overflow")?;
        body.resize(end, 0);
        self.exact(&mut body[start..], incomplete)
    }

    fn chunked(&mut self) -> Result<Vec<u8>, String> {
        let mut body = Vec::new();
        loop {
            let line = self.line("chunked response missing chunk size")?;
            let text = std::str::from_utf8(&line)
                .map_err(|_| "chunked response has invalid chunk size")?;
            let text = text
                .split(';')
                .next()
                .unwrap_or("")
                .trim_matches([' ', '\t']);
            if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("chunked response has invalid chunk size".to_owned());
            }
            let size = usize::from_str_radix(text, 16)
                .map_err(|_| "chunked response has invalid chunk size")?;
            if size == 0 {
                loop {
                    let trailer = self.line("chunked response missing trailer terminator")?;
                    if trailer.is_empty() {
                        return Ok(body);
                    }
                    let (name, _) = parse_field(&trailer)?;
                    if matches!(name.as_str(), "content-length" | "transfer-encoding") {
                        return Err("chunked response has forbidden framing trailer".to_owned());
                    }
                    // Trailers never overwrite control-plane capability/auth headers.
                }
            }
            self.append_exact(&mut body, size, "chunked response ended inside a chunk")?;
            let mut ending = [0; 2];
            self.exact(&mut ending, "chunked response ended inside a chunk")?;
            if ending != *b"\r\n" {
                return Err("chunked response chunk missing trailing CRLF".to_owned());
            }
        }
    }

    fn until_eof(&mut self) -> Result<Vec<u8>, String> {
        let mut body = Vec::new();
        loop {
            let available = self
                .stream
                .fill_buf()
                .map_err(|error| format!("read HTTP response: {error}"))?;
            if available.is_empty() {
                return Ok(body);
            }
            let length = available.len();
            if length > MAX_HTTP_RESPONSE_BYTES - self.consumed {
                return Err(format!(
                    "HTTP response exceeds {MAX_HTTP_RESPONSE_BYTES} byte limit"
                ));
            }
            body.extend_from_slice(available);
            self.stream.consume(length);
            self.consumed += length;
        }
    }
}

#[cfg(test)]
pub(crate) fn parse_http_response(raw: &[u8]) -> Result<HttpResponse, String> {
    read_response(raw, "GET")
}

#[cfg(test)]
pub(crate) fn decode_chunked_body(body: &[u8]) -> Result<Vec<u8>, String> {
    ResponseReader::new(body).chunked()
}
