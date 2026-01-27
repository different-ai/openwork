use std::env;
use std::fs;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn main() {
  ensure_opencode_sidecar();
  ensure_openwork_server_sidecar();
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

  let canonical_name = if target.contains("windows") {
    "opencode.exe"
  } else {
    "opencode"
  };

  let mut target_name = format!("opencode-{target}");
  if target.contains("windows") {
    target_name.push_str(".exe");
  }

  let dest_path = sidecar_dir.join(canonical_name);
  let target_dest_path = sidecar_dir.join(target_name);

  let profile = env::var("PROFILE").unwrap_or_default();
  if !dest_path.exists() {
    create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
  }
  if !target_dest_path.exists() {
    create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
  }

  if dest_path.exists() && target_dest_path.exists() {
    return;
  }

  if target_dest_path.exists() && !dest_path.exists() {
    if copy_sidecar(&target_dest_path, &dest_path, &target) {
      return;
    }
  }

  let source_path = env::var("OPENCODE_BIN_PATH")
    .ok()
    .map(PathBuf::from)
    .filter(|path| path.is_file())
    .or_else(|| find_in_path(if target.contains("windows") { "opencode.exe" } else { "opencode" }));

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

  let copied = copy_sidecar(&source_path, &dest_path, &target);

  if copied {
    #[cfg(unix)]
    {
      let _ = fs::set_permissions(&dest_path, fs::Permissions::from_mode(0o755));
    }
    let _ = copy_sidecar(&dest_path, &target_dest_path, &target);
  } else {
    println!(
      "cargo:warning=Failed to copy OpenCode sidecar from {} to {}",
      source_path.display(),
      dest_path.display()
    );
    create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
  }
}

fn ensure_openwork_server_sidecar() {
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

  let canonical_name = if target.contains("windows") {
    "openwork-server.exe"
  } else {
    "openwork-server"
  };

  let mut target_name = format!("openwork-server-{target}");
  if target.contains("windows") {
    target_name.push_str(".exe");
  }

  let dest_path = sidecar_dir.join(canonical_name);
  let target_dest_path = sidecar_dir.join(target_name);

  if dest_path.exists() {
    return;
  }

  if target_dest_path.exists() {
    if copy_sidecar(&target_dest_path, &dest_path, &target) {
      return;
    }
  }

  let source_path = env::var("OPENWORK_SERVER_BIN_PATH")
    .ok()
    .map(PathBuf::from)
    .filter(|path| path.is_file())
    .or_else(|| {
      find_in_path(if target.contains("windows") {
        "openwork-server.exe"
      } else {
        "openwork-server"
      })
    });

  let profile = env::var("PROFILE").unwrap_or_default();

  let Some(source_path) = source_path else {
    println!(
      "cargo:warning=OpenWork server sidecar missing at {} (set OPENWORK_SERVER_BIN_PATH or install openwork-server)",
      dest_path.display()
    );

    create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    return;
  };

  if fs::create_dir_all(&sidecar_dir).is_err() {
    return;
  }

  let copied = copy_sidecar(&source_path, &dest_path, &target);

  if copied {
    #[cfg(unix)]
    {
      let _ = fs::set_permissions(&dest_path, fs::Permissions::from_mode(0o755));
    }
    let _ = copy_sidecar(&dest_path, &target_dest_path, &target);
  } else {
    println!(
      "cargo:warning=Failed to copy OpenWork server sidecar from {} to {}",
      source_path.display(),
      dest_path.display()
    );
    create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
  }

  if !dest_path.exists() {
    create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
  }
  if !target_dest_path.exists() {
    create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
  }
}

fn copy_sidecar(source_path: &PathBuf, dest_path: &PathBuf, target: &str) -> bool {
  let mut copied = fs::copy(source_path, dest_path).is_ok();

  #[cfg(unix)]
  if !copied {
    if std::os::unix::fs::symlink(source_path, dest_path).is_ok() {
      copied = true;
    }
  }

  #[cfg(windows)]
  if !copied {
    if fs::hard_link(source_path, dest_path).is_ok() {
      copied = true;
    }
  }

  if copied {
    #[cfg(unix)]
    {
      let _ = fs::set_permissions(dest_path, fs::Permissions::from_mode(0o755));
    }
  } else if target.contains("windows") {
    let _ = fs::remove_file(dest_path);
  }

  copied
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
  if profile == "release" || target.contains("windows") {
    return;
  }

  if fs::create_dir_all(sidecar_dir).is_err() {
    return;
  }

  let stub = "#!/usr/bin/env bash\n\
echo 'Sidecar missing. Install the binary or set the *_BIN_PATH env var.'\n\
exit 1\n";
  if fs::write(dest_path, stub).is_ok() {
    #[cfg(unix)]
    let _ = fs::set_permissions(dest_path, fs::Permissions::from_mode(0o755));
  }
}
