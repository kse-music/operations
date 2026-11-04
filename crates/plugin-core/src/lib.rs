//! Package validation and local metadata. This crate never executes package contents.
pub mod manifest;
pub mod package;
pub mod permissions;
pub mod repository;

pub use manifest::*;
pub use package::{Package, PackageFile, ValidatedPackage};
pub use repository::{InstallInput, InstalledPlugin, Repository, UninstallInput};
use serverdeck_core::Error;

pub(crate) fn invalid(message: &'static str) -> Error {
    Error::Connection {
        code: "PLUGIN_INVALID",
        message,
        source: None,
    }
}
pub(crate) fn io(error: std::io::Error) -> Error {
    Error::Storage(Box::new(error))
}
