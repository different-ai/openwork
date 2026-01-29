use tauri::{AppHandle, State};
use tauri_plugin_shell::process::CommandEvent;

use crate::owpenbot::manager::OwpenbotManager;
use crate::owpenbot::spawn::spawn_owpenbot;
use crate::types::OwpenbotInfo;
use crate::utils::truncate_output;

#[tauri::command]
pub async fn owpenbot_info(
    app: AppHandle,
    manager: State<'_, OwpenbotManager>,
) -> Result<OwpenbotInfo, String> {
    let mut info = {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "owpenbot mutex poisoned".to_string())?;
        OwpenbotManager::snapshot_locked(&mut state)
    };

    // Only fetch from CLI status if manager doesn't have values (fallback for when sidecar isn't started)
    if info.opencode_url.is_none() || info.workspace_path.is_none() {
        if let Ok(status) = owpenbot_json(&app, &["status", "--json"], "get status").await {
            if let Some(opencode) = status.get("opencode") {
                if info.opencode_url.is_none() {
                    if let Some(url) = opencode.get("url").and_then(|value| value.as_str()) {
                        let trimmed = url.trim();
                        if !trimmed.is_empty() {
                            info.opencode_url = Some(trimmed.to_string());
                        }
                    }
                }
                if info.workspace_path.is_none() {
                    if let Some(directory) = opencode.get("directory").and_then(|value| value.as_str()) {
                        let trimmed = directory.trim();
                        if !trimmed.is_empty() {
                            info.workspace_path = Some(trimmed.to_string());
                        }
                    }
                }
            }

            if let Some(whatsapp) = status.get("whatsapp") {
                if let Some(linked) = whatsapp.get("linked").and_then(|value| value.as_bool()) {
                    info.whatsapp_linked = linked;
                }
            }

            if let Some(telegram) = status.get("telegram") {
                if let Some(configured) = telegram.get("configured").and_then(|value| value.as_bool()) {
                    info.telegram_configured = configured;
                }
            }
        }
    }

    Ok(info)
}

#[tauri::command]
pub fn owpenbot_start(
    app: AppHandle,
    manager: State<OwpenbotManager>,
    workspace_path: String,
    opencode_url: Option<String>,
) -> Result<OwpenbotInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "owpenbot mutex poisoned".to_string())?;
    OwpenbotManager::stop_locked(&mut state);

    let (mut rx, child) = spawn_owpenbot(&app, &workspace_path, opencode_url.as_deref())?;

    state.child = Some(child);
    state.child_exited = false;
    state.workspace_path = Some(workspace_path);
    state.opencode_url = opencode_url;
    state.last_stdout = None;
    state.last_stderr = None;

    let state_handle = manager.inner.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next = state
                            .last_stdout
                            .as_deref()
                            .unwrap_or_default()
                            .to_string()
                            + &line;
                        state.last_stdout = Some(truncate_output(&next, 8000));

                        // Check for WhatsApp linked status in output
                        if line.contains("WhatsApp linked") {
                            state.whatsapp_linked = true;
                        }
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next = state
                            .last_stderr
                            .as_deref()
                            .unwrap_or_default()
                            .to_string()
                            + &line;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                        if let Some(code) = payload.code {
                            let next = format!("Owpenbot exited (code {code}).");
                            state.last_stderr = Some(truncate_output(&next, 8000));
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                        let next = state
                            .last_stderr
                            .as_deref()
                            .unwrap_or_default()
                            .to_string()
                            + &message;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                _ => {}
            }
        }
    });

    Ok(OwpenbotManager::snapshot_locked(&mut state))
}

#[tauri::command]
pub fn owpenbot_stop(manager: State<OwpenbotManager>) -> Result<OwpenbotInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "owpenbot mutex poisoned".to_string())?;
    OwpenbotManager::stop_locked(&mut state);
    Ok(OwpenbotManager::snapshot_locked(&mut state))
}

#[tauri::command]
pub async fn owpenbot_qr(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_shell::ShellExt;
    use base64::engine::general_purpose;
    use base64::Engine as _;
    use image::{DynamicImage, ImageFormat, Luma};
    use qrcode::QrCode;
    use std::io::Cursor;

    let command = match app.shell().sidecar("owpenbot") {
        Ok(command) => command,
        Err(_) => app.shell().command("owpenbot"),
    };

    let output = command
        .args(["whatsapp", "qr", "--format", "ascii", "--json"])
        .output()
        .await
        .map_err(|e| format!("Failed to get QR code: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get QR code: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON response
    #[derive(serde::Deserialize)]
    struct QrResponse {
        qr: Option<String>,
        error: Option<String>,
    }

    let response: QrResponse =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse QR response: {e}"))?;

    if let Some(error) = response.error {
        return Err(error);
    }

    let qr_data = response.qr.ok_or_else(|| "No QR code returned".to_string())?;
    let code = QrCode::new(qr_data.as_bytes()).map_err(|e| format!("Failed to encode QR: {e}"))?;
    let image = code
        .render::<Luma<u8>>()
        .min_dimensions(256, 256)
        .build();
    let mut buffer = Vec::new();
    DynamicImage::ImageLuma8(image)
        .write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png)
        .map_err(|e| format!("Failed to encode QR image: {e}"))?;
    Ok(general_purpose::STANDARD.encode(buffer))
}

#[tauri::command]
pub async fn owpenbot_status(
    app: AppHandle,
    manager: State<'_, OwpenbotManager>,
) -> Result<serde_json::Value, String> {
    let status = owpenbot_json(&app, &["status", "--json"], "get status").await?;
    let whatsapp = owpenbot_json(&app, &["whatsapp", "status", "--json"], "get WhatsApp status").await?;
    let telegram = owpenbot_json(&app, &["telegram", "status", "--json"], "get Telegram status").await?;

    let running = {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "owpenbot mutex poisoned".to_string())?;
        OwpenbotManager::snapshot_locked(&mut state).running
    };

    let config_path = status
        .get("config")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let opencode_url = status
        .get("opencode")
        .and_then(|value| value.get("url"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    let whatsapp_linked = whatsapp
        .get("linked")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let whatsapp_dm_policy = whatsapp
        .get("dmPolicy")
        .and_then(|value| value.as_str())
        .unwrap_or("pairing");
    let whatsapp_allow_from = whatsapp
        .get("allowFrom")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let telegram_configured = telegram
        .get("configured")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let telegram_enabled = telegram
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    Ok(serde_json::json!({
        "running": running,
        "config": config_path,
        "whatsapp": {
            "linked": whatsapp_linked,
            "dmPolicy": whatsapp_dm_policy,
            "allowFrom": whatsapp_allow_from,
        },
        "telegram": {
            "configured": telegram_configured,
            "enabled": telegram_enabled,
        },
        "opencode": {
            "url": opencode_url,
        },
    }))
}

#[tauri::command]
pub async fn owpenbot_config_set(
    app: AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let command = match app.shell().sidecar("owpenbot") {
        Ok(command) => command,
        Err(_) => app.shell().command("owpenbot"),
    };

    let output = command
        .args(["config", "set", &key, &value])
        .output()
        .await
        .map_err(|e| format!("Failed to set config: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to set config: {stderr}"));
    }

    Ok(())
}

#[tauri::command]
pub async fn owpenbot_pairing_list(app: AppHandle) -> Result<serde_json::Value, String> {
    owpenbot_json(&app, &["pairing", "list", "--json"], "list pairing requests").await
}

async fn owpenbot_json(
    app: &AppHandle,
    args: &[&str],
    context: &str,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_shell::ShellExt;

    let command = match app.shell().sidecar("owpenbot") {
        Ok(command) => command,
        Err(_) => app.shell().command("owpenbot"),
    };

    let output = command
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to {context}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to {context}: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse {context}: {e}"))
}

#[tauri::command]
pub async fn owpenbot_pairing_approve(app: AppHandle, code: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let command = match app.shell().sidecar("owpenbot") {
        Ok(command) => command,
        Err(_) => app.shell().command("owpenbot"),
    };

    let output = command
        .args(["pairing", "approve", &code])
        .output()
        .await
        .map_err(|e| format!("Failed to approve pairing: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to approve pairing: {stderr}"));
    }

    Ok(())
}

#[tauri::command]
pub async fn owpenbot_pairing_deny(app: AppHandle, code: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let command = match app.shell().sidecar("owpenbot") {
        Ok(command) => command,
        Err(_) => app.shell().command("owpenbot"),
    };

    let output = command
        .args(["pairing", "deny", &code])
        .output()
        .await
        .map_err(|e| format!("Failed to deny pairing: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to deny pairing: {stderr}"));
    }

    Ok(())
}
