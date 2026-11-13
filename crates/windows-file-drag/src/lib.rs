#![cfg(windows)]

mod drives;
mod ole;
mod open;
mod recycle;

pub use drives::local_drives;
pub use ole::start;
pub use open::open_with;
pub use recycle::recycle;
