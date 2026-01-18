use std::path::Path;
use std::process::Command;

#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
mod unix;

#[cfg(windows)]
pub use windows::{command_for_program, configure_hidden};
#[cfg(not(windows))]
pub use unix::{command_for_program, configure_hidden};

pub fn command_for_program_default(program: &Path) -> Command {
  command_for_program(program)
}
