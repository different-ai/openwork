use std::ffi::OsStr;
use std::path::Path;

use crate::engine::paths::resolve_opencode_executable;
use crate::platform::command_for_program;
use crate::utils::truncate_output;

/// Minimum recommended OpenCode CLI version for security fixes (e.g. CVE-2026-22812).
pub const MIN_SAFE_ENGINE_VERSION: &str = "1.1.10";

fn parse_semver_like(input: &str) -> Option<(u32, u32, u32)> {
  // Extract the first numeric+dot run, e.g. "opencode v1.2.3-beta" -> "1.2.3".
  let mut buf = String::new();
  let mut seen_digit = false;

  for ch in input.chars() {
    if ch.is_ascii_digit() {
      buf.push(ch);
      seen_digit = true;
    } else if ch == '.' && seen_digit {
      buf.push(ch);
    } else if seen_digit {
      break;
    }
  }

  if buf.is_empty() {
    return None;
  }

  let mut parts = buf.split('.');
  let major: u32 = parts.next()?.parse().ok()?;
  let minor: u32 = parts.next().unwrap_or("0").parse().ok()?;
  let patch: u32 = parts.next().unwrap_or("0").parse().ok()?;

  Some((major, minor, patch))
}

/// Returns Some(true) if `version` is ≥ MIN_SAFE_ENGINE_VERSION,
/// Some(false) if it is clearly older, or None if parsing fails.
pub fn is_engine_version_safe(version: &str) -> Option<bool> {
  let current = parse_semver_like(version)?;
  let minimum = parse_semver_like(MIN_SAFE_ENGINE_VERSION)?;
  Some(current >= minimum)
}

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

pub fn resolve_sidecar_candidate(
  prefer_sidecar: bool,
  resource_dir: Option<&Path>,
  current_bin_dir: Option<&Path>,
) -> (Option<std::path::PathBuf>, Vec<String>) {
  if !prefer_sidecar {
    return (None, Vec::new());
  }

  let mut notes = Vec::new();

  let mut candidates = Vec::new();

  if let Some(current_bin_dir) = current_bin_dir {
    candidates.push(current_bin_dir.join(crate::engine::paths::opencode_executable_name()));
  }

  if let Some(resource_dir) = resource_dir {
    candidates.push(
      resource_dir
        .join("sidecars")
        .join(crate::engine::paths::opencode_executable_name()),
    );
    candidates.push(resource_dir.join(crate::engine::paths::opencode_executable_name()));
  }

  candidates.push(
    std::path::PathBuf::from("src-tauri/sidecars")
      .join(crate::engine::paths::opencode_executable_name()),
  );

  for candidate in candidates {
    if candidate.is_file() {
      notes.push(format!("Using bundled sidecar: {}", candidate.display()));
      return (Some(candidate), notes);
    }

    notes.push(format!("Sidecar missing: {}", candidate.display()));
  }

  (None, notes)
}

pub fn resolve_engine_path(
  prefer_sidecar: bool,
  resource_dir: Option<&Path>,
  current_bin_dir: Option<&Path>,
) -> (Option<std::path::PathBuf>, bool, Vec<String>) {
  let (sidecar, mut notes) =
    resolve_sidecar_candidate(prefer_sidecar, resource_dir, current_bin_dir);
  let (resolved, in_path, more_notes) = match sidecar {
    Some(path) => (Some(path), false, Vec::new()),
    None => resolve_opencode_executable(),
  };

  notes.extend(more_notes);
  (resolved, in_path, notes)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_semver_like_versions() {
    assert_eq!(super::parse_semver_like("1.2.3"), Some((1, 2, 3)));
    assert_eq!(super::parse_semver_like("opencode v1.2.3-beta"), Some((1, 2, 3)));
    assert_eq!(super::parse_semver_like("v2.0.0"), Some((2, 0, 0)));
    assert_eq!(super::parse_semver_like("not-a-version"), None);
  }

  #[test]
  fn detects_safe_versions_relative_to_minimum() {
    // MIN_SAFE_ENGINE_VERSION is 1.1.10
    assert_eq!(super::is_engine_version_safe("1.1.10"), Some(true));
    assert_eq!(super::is_engine_version_safe("1.1.11"), Some(true));
    assert_eq!(super::is_engine_version_safe("1.2.0"), Some(true));
    assert_eq!(super::is_engine_version_safe("1.1.9"), Some(false));
    assert_eq!(super::is_engine_version_safe("1.0.0"), Some(false));
  }

  #[cfg(not(windows))]
  fn unique_temp_dir(name: &str) -> std::path::PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};

    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0);

    let mut dir = std::env::temp_dir();
    dir.push(format!("openwork-{name}-{}-{}", std::process::id(), nanos));
    dir
  }

  #[test]
  #[cfg(not(windows))]
  fn resolves_sidecar_from_current_binary_dir() {
    let dir = unique_temp_dir("sidecar-test");
    std::fs::create_dir_all(&dir).expect("create temp dir");

    let sidecar_path = dir.join(crate::engine::paths::opencode_executable_name());
    std::fs::write(&sidecar_path, b"").expect("create fake sidecar");

    let (resolved, notes) = resolve_sidecar_candidate(true, None, Some(dir.as_path()));
    assert_eq!(resolved.as_ref(), Some(&sidecar_path));
    assert!(notes
      .iter()
      .any(|note| note.contains("Using bundled sidecar")), "missing success note: {:?}", notes);

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  #[cfg(not(windows))]
  fn resolve_engine_path_prefers_sidecar() {
    let dir = unique_temp_dir("engine-path-test");
    std::fs::create_dir_all(&dir).expect("create temp dir");

    let sidecar_path = dir.join(crate::engine::paths::opencode_executable_name());
    std::fs::write(&sidecar_path, b"").expect("create fake sidecar");

    let (resolved, in_path, _notes) = resolve_engine_path(true, None, Some(dir.as_path()));
    assert_eq!(resolved.as_ref(), Some(&sidecar_path));
    assert!(!in_path);

    let _ = std::fs::remove_dir_all(&dir);
  }
}
