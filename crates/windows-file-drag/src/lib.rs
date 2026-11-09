#![cfg(windows)]

mod drives;
mod ole;
mod open;

pub use drives::local_drives;
pub use ole::start;
pub use open::open_with;
