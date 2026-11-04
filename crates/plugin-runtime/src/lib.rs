//! Fuel-metered WebAssembly with no WASI, filesystem, network, env or native imports.
mod manager;
pub mod protocol;
mod vm;
pub use manager::Runtime;
use serverdeck_core::Error;

pub(crate) fn failure(code: &'static str, message: &'static str) -> Error {
    Error::Connection {
        code,
        message,
        source: None,
    }
}

#[cfg(test)]
mod tests;
