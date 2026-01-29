use tauri::{AppHandle, State};
use tauri_plugin_shell::process::CommandEvent;

use crate::owpenbot::manager::OwpenbotManager;
use crate::owpenbot::spawn::spawn_owpenbot;
use crate::types::OwpenbotInfo;
use crate::utils::truncate_output;

#[tauri::command]
pub fn owpenbot_info(manager: State<OwpenbotManager>) -> OwpenbotInfo {
    let mut state = manager.inner.lock().expect("owpenbot mutex poisoned");
    OwpenbotManager::snapshot_locked(&mut state)
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

    let command = match app.shell().sidecar("owpenbot") {
        Ok(command) => command,
        Err(_) => app.shell().command("owpenbot"),
    };

    let output = command
        .args(["whatsapp", "qr", "--format", "base64", "--json"])
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

    response.qr.ok_or_else(|| "No QR code returned".to_string())
}
