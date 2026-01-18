use std::ffi::OsStr;
use std::path::Path;

use crate::engine::paths::resolve_opencode_executable;
use crate::platform::command_for_program;
use crate::utils::truncate_output;

pub fn opencode_version(program: &OsStr) -> Option<String> {
  let output = command_for_program(Path::new(program)).arg("--version").output().ok()?;
  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

  if !stdout.is_empty() {
    return Some(stdout);
  }
  if !stderr.is_empty() {
    return Some(stderr);
  }

  None
}

pub fn opencode_serve_help(program: &OsStr) -> (bool, Option<i32>, Option<String>, Option<String>) {
  match command_for_program(Path::new(program)).arg("serve").arg("--help").output() {
    Ok(output) => {
      let status = output.status.code();
      let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
      let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
      let ok = output.status.success();

      let stdout = if stdout.is_empty() {
        None
      } else {
        Some(truncate_output(&stdout, 4000))
      };
      let stderr = if stderr.is_empty() {
        None
      } else {
        Some(truncate_output(&stderr, 4000))
      };

      (ok, status, stdout, stderr)
    }
    Err(_) => (false, None, None, None),
  }
}

pub fn resolve_sidecar_candidate(prefer_sidecar: bool) -> (Option<std::path::PathBuf>, Vec<String>) {
  if !prefer_sidecar {
    return (None, Vec::new());
  }

  let mut notes = Vec::new();

  #[cfg(not(windows))]
  {
    let candidate = std::path::PathBuf::from("src-tauri/sidecars")
      .join(crate::engine::paths::opencode_executable_name());
    if candidate.is_file() {
      notes.push(format!("Using bundled sidecar: {}", candidate.display()));
      return (Some(candidate), notes);
    }

    notes.push(format!("Sidecar requested but missing: {}", candidate.display()));
    return (None, notes);
  }

  #[cfg(windows)]
  {
    notes.push("Sidecar requested but unsupported on Windows".to_string());
    (None, notes)
  }
}

pub fn resolve_engine_path(prefer_sidecar: bool) -> (Option<std::path::PathBuf>, bool, Vec<String>) {
  let (sidecar, mut notes) = resolve_sidecar_candidate(prefer_sidecar);
  let (resolved, in_path, more_notes) = match sidecar {
    Some(path) => (Some(path), false, Vec::new()),
    None => resolve_opencode_executable(),
  };

  notes.extend(more_notes);
  (resolved, in_path, notes)
}
