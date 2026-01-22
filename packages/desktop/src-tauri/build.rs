use std::env;
use std::fs;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn main() {
  // Ensure sidecar exists in all builds (debug and release)
  if let Err(e) = ensure_opencode_sidecar() {
    eprintln!("Error: {}", e);
    eprintln!("Install OpenCode or set OPENCODE_BIN_PATH.");
    std::process::exit(1);
  }
  tauri_build::build();
}

fn ensure_opencode_sidecar() -> Result<(), String> {
  let target = env::var("CARGO_CFG_TARGET_TRIPLE")
    .or_else(|_| env::var("TARGET"))
    .or_else(|_| env::var("TAURI_ENV_TARGET_TRIPLE"))
    .unwrap_or_default();
  if target.is_empty() {
    return Ok(());
  }

  let manifest_dir = env::var("CARGO_MANIFEST_DIR")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from("."));
  let sidecar_dir = manifest_dir.join("sidecars");

  let mut file_name = format!("opencode-{target}");
  if target.contains("windows") {
    file_name.push_str(".exe");
  }
  let dest_path = sidecar_dir.join(file_name);

  if dest_path.exists() {
    return Ok(());
  }

  let source_path = env::var("OPENCODE_BIN_PATH")
    .ok()
    .map(PathBuf::from)
    .filter(|path| path.is_file())
    .or_else(|| find_in_path(if target.contains("windows") { "opencode.exe" } else { "opencode" }));

  let Some(source_path) = source_path else {
    return Err(format!(
      "OpenCode not found. Install OpenCode or set OPENCODE_BIN_PATH."
    ));
  };

  if fs::create_dir_all(&sidecar_dir).is_err() {
    return Err(format!("Failed to create directory: {}", sidecar_dir.display()));
  }

  let mut copied = fs::copy(&source_path, &dest_path).is_ok();

  #[cfg(unix)]
  if !copied {
    if std::os::unix::fs::symlink(&source_path, &dest_path).is_ok() {
      copied = true;
    }
  }

  #[cfg(windows)]
  if !copied {
    if fs::hard_link(&source_path, &dest_path).is_ok() {
      copied = true;
    }
  }

  if copied {
    #[cfg(unix)]
    {
      let _ = fs::set_permissions(&dest_path, fs::Permissions::from_mode(0o755));
    }
    Ok(())
  } else {
    Err(format!(
      "Failed to copy OpenCode from {} to {}",
      source_path.display(),
      dest_path.display()
    ))
  }
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
  let paths = env::var_os("PATH")?;
  env::split_paths(&paths).find_map(|dir| {
    let candidate = dir.join(binary);
    if candidate.is_file() {
      Some(candidate)
    } else {
      None
    }
  })
}
