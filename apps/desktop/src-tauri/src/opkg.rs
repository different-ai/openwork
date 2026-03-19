use std::process::{Command, Stdio};

use crate::paths::apply_augmented_path;
use crate::platform::configure_hidden;
use crate::types::ExecResult;

pub fn run_capture_optional(command: &mut Command) -> Result<Option<ExecResult>, String> {
    match command.output() {
        Ok(output) => {
            let status = output.status.code().unwrap_or(-1);
            Ok(Some(ExecResult {
                ok: output.status.success(),
                status,
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "Failed to run {}: {e}",
            command.get_program().to_string_lossy()
        )),
    }
}

pub fn opkg_install(project_dir: &str, package: &str) -> Result<ExecResult, String> {
    let mut opkg = Command::new("opkg");
    apply_augmented_path(&mut opkg);
    configure_hidden(&mut opkg);
    opkg.arg("install")
        .arg(package)
        .current_dir(project_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(result) = run_capture_optional(&mut opkg)? {
        return Ok(result);
    }

    let mut openpackage = Command::new("openpackage");
    apply_augmented_path(&mut openpackage);
    configure_hidden(&mut openpackage);
    openpackage
        .arg("install")
        .arg(package)
        .current_dir(project_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(result) = run_capture_optional(&mut openpackage)? {
        return Ok(result);
    }

    let mut pnpm = Command::new("pnpm");
    apply_augmented_path(&mut pnpm);
    configure_hidden(&mut pnpm);
    pnpm.arg("dlx")
        .arg("opkg")
        .arg("install")
        .arg(package)
        .current_dir(project_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(result) = run_capture_optional(&mut pnpm)? {
        return Ok(result);
    }

    let mut npx = Command::new("npx");
    apply_augmented_path(&mut npx);
    configure_hidden(&mut npx);
    npx.arg("opkg")
        .arg("install")
        .arg(package)
        .current_dir(project_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(result) = run_capture_optional(&mut npx)? {
        return Ok(result);
    }

    Ok(ExecResult {
        ok: false,
        status: -1,
        stdout: String::new(),
        stderr: "OpenPackage CLI not found. Install with `npm install -g opkg` (or `openpackage`), or ensure pnpm/npx is available.".to_string(),
    })
}
