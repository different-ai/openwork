use std::path::Path;
use std::process::Command;
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn command_for_program(program: &Path) -> Command {
  if program
    .extension()
    .and_then(|ext| ext.to_str())
    .map(|ext| ext.eq_ignore_ascii_case("cmd"))
    .unwrap_or(false)
  {
    let mut command = Command::new("cmd");
    command.arg("/C").arg(program).creation_flags(CREATE_NO_WINDOW);
    return command;
  }

  let mut command = Command::new(program);
  command.creation_flags(CREATE_NO_WINDOW);
  command
}

pub fn configure_hidden(command: &mut Command) {
  command.creation_flags(CREATE_NO_WINDOW);
}
