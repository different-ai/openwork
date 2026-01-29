use std::sync::{Arc, Mutex};

use tauri_plugin_shell::process::CommandChild;

use crate::types::OwpenbotInfo;

#[derive(Default)]
pub struct OwpenbotManager {
    pub inner: Arc<Mutex<OwpenbotState>>,
}

#[derive(Default)]
pub struct OwpenbotState {
    pub child: Option<CommandChild>,
    pub child_exited: bool,
    pub workspace_path: Option<String>,
    pub opencode_url: Option<String>,
    pub qr_data: Option<String>,
    pub whatsapp_linked: bool,
    pub telegram_configured: bool,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

impl OwpenbotManager {
    pub fn snapshot_locked(state: &mut OwpenbotState) -> OwpenbotInfo {
        let (running, pid) = match state.child.as_ref() {
            None => (false, None),
            Some(_child) if state.child_exited => {
                state.child = None;
                (false, None)
            }
            Some(child) => (true, Some(child.pid())),
        };

        OwpenbotInfo {
            running,
            workspace_path: state.workspace_path.clone(),
            opencode_url: state.opencode_url.clone(),
            qr_data: state.qr_data.clone(),
            whatsapp_linked: state.whatsapp_linked,
            telegram_configured: state.telegram_configured,
            pid,
            last_stdout: state.last_stdout.clone(),
            last_stderr: state.last_stderr.clone(),
        }
    }

    pub fn stop_locked(state: &mut OwpenbotState) {
        if let Some(child) = state.child.take() {
            let _ = child.kill();
        }
        state.child_exited = true;
        state.workspace_path = None;
        state.opencode_url = None;
        state.qr_data = None;
        state.whatsapp_linked = false;
        state.telegram_configured = false;
        state.last_stdout = None;
        state.last_stderr = None;
    }
}
