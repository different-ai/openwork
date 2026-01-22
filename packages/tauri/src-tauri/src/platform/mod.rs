#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
mod unix;

#[cfg(windows)]
pub use windows::{command_for_program, configure_hidden};
#[cfg(not(windows))]
pub use unix::{command_for_program, configure_hidden};
