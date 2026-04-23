use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

const MIGRATION_SNAPSHOT_FILENAME: &str = "migration-snapshot.v1.json";
const MIGRATION_INSTALLER_LOG: &str = "migration-install.log";

#[derive(Debug, Deserialize)]
pub struct MigrationSnapshotPayload {
    pub version: u32,
    #[serde(rename = "writtenAt")]
    pub written_at: Option<i64>,
    pub source: Option<String>,
    pub keys: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct MigrateToElectronRequest {
    /// Full URL to the Electron artifact. On macOS we expect a .zip (not a
    /// .dmg) so we can swap the .app bundle in place without the user
    /// having to drag anything. On Windows: a .exe NSIS installer. On
    /// Linux: an AppImage.
    pub url: String,
    /// Optional sha256 to verify before we touch the filesystem.
    #[serde(default)]
    pub sha256: Option<String>,
    /// Optional override for where the new OpenWork bundle should land on
    /// macOS. Defaults to replacing the currently-running .app in place.
    #[serde(default)]
    pub target_app_path: Option<String>,
}

fn migration_snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create app_data_dir: {e}"))?;
    Ok(data_dir.join(MIGRATION_SNAPSHOT_FILENAME))
}

/// Snapshot workspace-related localStorage keys into app_data_dir so the
/// next-launch Electron shell can hydrate them. Called by the last Tauri
/// release right before it kicks off the Electron installer.
#[tauri::command]
pub fn write_migration_snapshot(
    app: AppHandle,
    snapshot: MigrationSnapshotPayload,
) -> Result<(), String> {
    if snapshot.version != 1 {
        return Err(format!(
            "Unsupported migration snapshot version: {}",
            snapshot.version
        ));
    }

    let path = migration_snapshot_path(&app)?;
    let serialized = serde_json::json!({
        "version": snapshot.version,
        "writtenAt": snapshot.written_at,
        "source": snapshot.source.unwrap_or_else(|| "tauri".to_string()),
        "keys": snapshot.keys,
    });
    let contents = serde_json::to_string_pretty(&serialized)
        .map_err(|e| format!("Failed to serialize snapshot: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Failed to write snapshot: {e}"))?;

    println!(
        "[migration] wrote {} key(s) to {}",
        snapshot.keys.len(),
        path.display()
    );

    Ok(())
}

#[cfg(target_os = "macos")]
fn current_app_bundle_path() -> Result<PathBuf, String> {
    // Tauri's running .app is <something>/Contents/MacOS/OpenWork. Walk up
    // two directories to get to <something>.app.
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let bundle = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| "unexpected .app layout".to_string())?;
    if bundle.extension().and_then(|s| s.to_str()) != Some("app") {
        return Err(format!(
            "resolved bundle is not an .app: {}",
            bundle.display()
        ));
    }
    Ok(bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn write_macos_migration_script(
    app: &AppHandle,
    url: &str,
    sha256: Option<&str>,
    target: &std::path::Path,
) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache dir: {e}"))?;
    fs::create_dir_all(&cache).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let log_path = cache.join(MIGRATION_INSTALLER_LOG);
    let script_path = cache.join("openwork-migrate.sh");

    let sha256_check = match sha256 {
        Some(hash) => format!(
            r#"
expected="{hash}"
actual=$(shasum -a 256 "$ZIP" | awk '{{print $1}}')
if [ "$actual" != "$expected" ]; then
  echo "sha256 mismatch: got $actual, expected $expected" >&2
  exit 1
fi
"#
        ),
        None => String::new(),
    };

    // The script runs detached AFTER Tauri exits. It downloads the Electron
    // zip, verifies Apple code signing, swaps the .app bundle, and relaunches.
    let script = format!(
        r#"#!/bin/bash
set -euo pipefail
exec >>"{log}" 2>&1
echo "[migration] script start $(date -u +%FT%TZ)"

TARGET="{target}"
URL="{url}"
WORK=$(mktemp -d /tmp/openwork-migrate-XXXXXX)
ZIP="$WORK/OpenWork-electron.zip"

# Wait for Tauri to fully exit before touching the .app bundle.
sleep 3

echo "[migration] downloading $URL"
curl --fail --location --silent --show-error --output "$ZIP" "$URL"
{sha256}

echo "[migration] extracting"
/usr/bin/unzip -q "$ZIP" -d "$WORK"

NEW_APP=$(find "$WORK" -maxdepth 2 -name 'OpenWork.app' -type d | head -n 1)
if [ -z "$NEW_APP" ]; then
  echo "[migration] no OpenWork.app in zip" >&2
  exit 1
fi

echo "[migration] verifying signature on $NEW_APP"
/usr/bin/codesign --verify --deep --strict "$NEW_APP"

echo "[migration] swapping bundle at $TARGET"
BACKUP="$TARGET.migrate-bak"
rm -rf "$BACKUP"
mv "$TARGET" "$BACKUP"
mv "$NEW_APP" "$TARGET"

echo "[migration] launching new bundle"
/usr/bin/open "$TARGET"

echo "[migration] done $(date -u +%FT%TZ)"
"#,
        log = log_path.display(),
        target = target.display(),
        url = url,
        sha256 = sha256_check,
    );

    fs::write(&script_path, script).map_err(|e| format!("Failed to write script: {e}"))?;
    let mut perms = fs::metadata(&script_path)
        .map_err(|e| format!("Failed to stat script: {e}"))?
        .permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o755);
    fs::set_permissions(&script_path, perms)
        .map_err(|e| format!("Failed to chmod script: {e}"))?;

    Ok(script_path)
}

#[cfg(target_os = "macos")]
fn spawn_macos_migration_script(script_path: &std::path::Path) -> Result<(), String> {
    // nohup + background so the script survives this process exiting.
    Command::new("/bin/bash")
        .arg("-c")
        .arg(format!("nohup bash \"{}\" >/dev/null 2>&1 &", script_path.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn migration script: {e}"))?;
    Ok(())
}

/// Download the Electron installer, verify it, swap the .app bundle, and
/// relaunch — then exit this Tauri process so the script can finish the
/// handoff. The previous .app is kept at `<app>.migrate-bak` for rollback.
///
/// The caller (renderer) is expected to have already invoked
/// `write_migration_snapshot` so the new Electron shell can hydrate
/// localStorage on first launch.
#[tauri::command]
pub async fn migrate_to_electron(
    app: AppHandle,
    request: MigrateToElectronRequest,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let target = match request.target_app_path {
            Some(path) => PathBuf::from(path),
            None => current_app_bundle_path()?,
        };
        let script = write_macos_migration_script(
            &app,
            &request.url,
            request.sha256.as_deref(),
            &target,
        )?;
        spawn_macos_migration_script(&script)?;
        // Give the script a moment to daemonize before we exit.
        std::thread::sleep(std::time::Duration::from_millis(400));
        app.exit(0);
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        // TODO(migration-windows): download the NSIS .exe, run with
        // /S /D=<install-dir>, wait for exit, relaunch. For now, open
        // the installer in the user's browser.
        let _ = request;
        let _ = app;
        Err("Windows migrate_to_electron is not wired yet — handle via manual install".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        // TODO(migration-linux): handle AppImage + tarball installs.
        let _ = request;
        let _ = app;
        Err("Linux migrate_to_electron is not wired yet — handle via manual install".to_string())
    }
}
