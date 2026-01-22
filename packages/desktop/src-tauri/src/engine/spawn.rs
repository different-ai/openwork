use std::path::Path;
use std::process::{Child, Command, Stdio};

use crate::paths::{candidate_xdg_config_dirs, candidate_xdg_data_dirs, maybe_infer_xdg_home};
use crate::platform::configure_hidden;

pub fn find_free_port() -> Result<u16, String> {
  let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  Ok(port)
}

pub fn build_engine_command(program: &Path, hostname: &str, port: u16, project_dir: &str) -> Command {
  let mut command = crate::platform::command_for_program(program);
  configure_hidden(&mut command);
  command
    .arg("serve")
    .arg("--hostname")
    .arg(hostname)
    .arg("--port")
    .arg(port.to_string())
    .arg("--cors")
    .arg("http://localhost:5173")
    .arg("--cors")
    .arg("tauri://localhost")
    .arg("--cors")
    .arg("http://tauri.localhost")
    .current_dir(project_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  if let Some(xdg_data_home) = maybe_infer_xdg_home(
    "XDG_DATA_HOME",
    candidate_xdg_data_dirs(),
    Path::new("opencode/auth.json"),
  ) {
    command.env("XDG_DATA_HOME", xdg_data_home);
  }

  if let Some(xdg_config_home) = maybe_infer_xdg_home(
    "XDG_CONFIG_HOME",
    candidate_xdg_config_dirs(),
    Path::new("opencode/opencode.json"),
  ) {
    command.env("XDG_CONFIG_HOME", xdg_config_home);
  }

  command.env("OPENCODE_CLIENT", "openwork");
  command.env("OPENWORK", "1");
  command
}

pub fn spawn_engine(command: &mut Command) -> Result<Child, String> {
  command.spawn().map_err(|e| format!("Failed to start opencode: {e}"))
}
