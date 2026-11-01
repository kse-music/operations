use super::*;
use base64::Engine as _;
use serverdeck_core::connection::{ProxyKind, ProxySettings};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};
pub(crate) trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}
pub(crate) type Stream = Box<dyn Io>;
pub struct ProxyConnection {
    pub settings: ProxySettings,
    pub password: Option<Zeroizing<String>>,
    pub revision: u32,
}

pub(crate) async fn connect(
    host: &str,
    port: u16,
    proxy: Option<ProxyConnection>,
) -> Result<Stream, Error> {
    let Some(proxy) = proxy else {
        let stream = TcpStream::connect((host, port)).await.map_err(io_error)?;
        stream.set_nodelay(true).map_err(io_error)?;
        return Ok(Box::new(stream));
    };
    let mut stream = TcpStream::connect((proxy.settings.hostname.as_str(), proxy.settings.port))
        .await
        .map_err(io_error)?;
    stream.set_nodelay(true).map_err(io_error)?;
    match proxy.settings.kind {
        ProxyKind::Socks5 => {
            let auth = proxy.settings.username.is_some();
            stream
                .write_all(if auth { &[5, 1, 2] } else { &[5, 1, 0] })
                .await
                .map_err(io_error)?;
            let mut response = [0; 2];
            stream.read_exact(&mut response).await.map_err(io_error)?;
            if response != [5, if auth { 2 } else { 0 }] {
                return Err(failure("SSH_PROXY_AUTH", "SOCKS5 代理不接受配置的认证方式"));
            }
            if let Some(user) = proxy.settings.username {
                let secret = proxy
                    .password
                    .ok_or_else(|| failure("SSH_PROXY_AUTH", "代理安全密码不存在"))?;
                if secret.len() > 255 {
                    return Err(failure(
                        "SSH_PROXY_AUTH",
                        "SOCKS5 密码超过协议 255 字节限制",
                    ));
                }
                let mut credentials = Zeroizing::new(vec![1, user.len() as u8]);
                credentials.extend_from_slice(user.as_bytes());
                credentials.push(secret.len() as u8);
                credentials.extend_from_slice(secret.as_bytes());
                stream.write_all(&credentials).await.map_err(io_error)?;
                stream.read_exact(&mut response).await.map_err(io_error)?;
                if response != [1, 0] {
                    return Err(failure("SSH_PROXY_AUTH", "SOCKS5 代理认证失败"));
                }
            }
            let mut request = vec![5, 1, 0];
            encode_address(host, port, &mut request)?;
            stream.write_all(&request).await.map_err(io_error)?;
            let mut head = [0; 4];
            stream.read_exact(&mut head).await.map_err(io_error)?;
            if head[0] != 5 || head[1] != 0 || head[2] != 0 {
                return Err(failure("SSH_PROXY_REJECTED", "SOCKS5 代理拒绝目标连接"));
            }
            discard_address(&mut stream, head[3]).await?;
        }
        ProxyKind::HttpConnect => {
            let target = if host.contains(':') {
                format!("[{host}]:{port}")
            } else {
                format!("{host}:{port}")
            };
            let mut request =
                Zeroizing::new(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n"));
            if let Some(user) = proxy.settings.username {
                let password = proxy
                    .password
                    .ok_or_else(|| failure("SSH_PROXY_AUTH", "代理安全密码不存在"))?;
                let credentials = Zeroizing::new(format!("{user}:{}", password.as_str()));
                let encoded = Zeroizing::new(
                    base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes()),
                );
                request.push_str("Proxy-Authorization: Basic ");
                request.push_str(&encoded);
                request.push_str("\r\n");
            }
            request.push_str("\r\n");
            stream
                .write_all(request.as_bytes())
                .await
                .map_err(io_error)?;
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                if header.len() >= 8192 {
                    return Err(failure("SSH_PROXY_HEADER", "HTTP CONNECT 响应头超过 8 KiB"));
                }
                header.push(stream.read_u8().await.map_err(io_error)?);
            }
            let line = header.split(|b| *b == b'\n').next().unwrap_or_default();
            let fields: Vec<_> = line.split(|b| *b == b' ').collect();
            if fields.len() < 2
                || !matches!(fields[0], b"HTTP/1.0" | b"HTTP/1.1")
                || fields[1] != b"200"
            {
                return Err(failure(
                    "SSH_PROXY_REJECTED",
                    "HTTP CONNECT 代理拒绝连接或需要不同认证方式",
                ));
            }
        }
    }
    Ok(Box::new(stream))
}
pub(crate) fn io_error(error: std::io::Error) -> Error {
    Error::Connection {
        code: "SSH_NETWORK",
        message: "网络读写或连接失败",
        source: Some(Box::new(error)),
    }
}
pub(crate) fn encode_address(host: &str, port: u16, output: &mut Vec<u8>) -> Result<(), Error> {
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            output.push(1);
            output.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            output.push(4);
            output.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            if host.is_empty() || host.len() > 253 {
                return Err(failure("SSH_PROXY_ADDRESS", "SOCKS 目标域名无效"));
            }
            output.extend_from_slice(&[3, host.len() as u8]);
            output.extend_from_slice(host.as_bytes());
        }
    }
    output.extend_from_slice(&port.to_be_bytes());
    Ok(())
}
pub(crate) async fn read_address<R: AsyncRead + Unpin>(
    stream: &mut R,
    kind: u8,
) -> Result<(String, u16), Error> {
    let host = match kind {
        1 => {
            let mut v = [0; 4];
            stream.read_exact(&mut v).await.map_err(io_error)?;
            std::net::Ipv4Addr::from(v).to_string()
        }
        4 => {
            let mut v = [0; 16];
            stream.read_exact(&mut v).await.map_err(io_error)?;
            std::net::Ipv6Addr::from(v).to_string()
        }
        3 => {
            let len = stream.read_u8().await.map_err(io_error)?;
            if len == 0 {
                return Err(failure("SSH_PROXY_ADDRESS", "SOCKS 域名为空"));
            }
            let mut v = vec![0; usize::from(len)];
            stream.read_exact(&mut v).await.map_err(io_error)?;
            String::from_utf8(v).map_err(|_| failure("SSH_PROXY_ADDRESS", "SOCKS 域名编码无效"))?
        }
        _ => return Err(failure("SSH_PROXY_ADDRESS", "SOCKS 地址类型不支持")),
    };
    let port = stream.read_u16().await.map_err(io_error)?;
    Ok((host, port))
}
async fn discard_address<R: AsyncRead + Unpin>(stream: &mut R, kind: u8) -> Result<(), Error> {
    read_address(stream, kind).await.map(|_| ())
}
