use std::env;
use std::fs;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn main() {
  // Always create sidecar for production builds
  let profile = env::var("PROFILE").unwrap_or_default();
  if profile == "release" {
    ensure_opencode_sidecar();
  }
  tauri_build::build();
}

fn ensure_opencode_sidecar() {
  let target = env::var("CARGO_CFG_TARGET_TRIPLE")
    .or_else(|_| env::var("TARGET"))
    .or_else(|_| env::var("TAURI_ENV_TARGET_TRIPLE"))
    .unwrap_or_default();
  if target.is_empty() {
    return;
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
    return;
  }

  let source_path = env::var("OPENCODE_BIN_PATH")
    .ok()
    .map(PathBuf::from)
    .filter(|path| path.is_file())
    .or_else(|| find_in_path(if target.contains("windows") { "opencode.exe" } else { "opencode" }));

  let profile = env::var("PROFILE").unwrap_or_default();

  let Some(source_path) = source_path else {
    println!(
      "cargo:warning=OpenCode sidecar missing at {} (set OPENCODE_BIN_PATH or install OpenCode)",
      dest_path.display()
    );

    create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    return;
  };

  if fs::create_dir_all(&sidecar_dir).is_err() {
    return;
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
  } else {
    println!(
      "cargo:warning=Failed to copy OpenCode sidecar from {} to {}",
      source_path.display(),
      dest_path.display()
    );
    create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
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

fn create_debug_stub(dest_path: &PathBuf, sidecar_dir: &PathBuf, profile: &str, target: &str) {
  if profile != "debug" || target.contains("windows") {
    return;
  }

  if fs::create_dir_all(sidecar_dir).is_err() {
    return;
  }

  let stub = format!("#!/usr/bin/env bash\n\
echo 'ERROR: This is a stub file, not a real OpenCode binary.'\n\
echo ''\n\
echo 'To fix this issue:'\n\
echo \"  1. Delete: sidecars/opencode-{}\"\n\
echo \"  2. Delete: target/{}/opencode\"\n\
echo \"  3. Run: pnpm dev\"\n\
echo ''\n\
echo 'For development, OpenWork uses opencode from your PATH.'\n\
echo 'Install OpenCode or set OPENCODE_BIN_PATH.'\n\
exit 1\n", target, profile);
  if fs::write(dest_path, stub).is_ok() {
    #[cfg(unix)]
    let _ = fs::set_permissions(dest_path, fs::Permissions::from_mode(0o755));
  }
}
