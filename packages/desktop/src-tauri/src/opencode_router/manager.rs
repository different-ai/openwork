use std::sync::{Arc, Mutex};

use tauri_plugin_shell::process::CommandChild;

use crate::types::OpenCodeRouterInfo;

#[derive(Default)]
pub struct OpenCodeRouterManager {
    pub inner: Arc<Mutex<OpenCodeRouterState>>,
}

#[derive(Default)]
pub struct OpenCodeRouterState {
    pub child: Option<CommandChild>,
    pub child_exited: bool,
    pub version: Option<String>,
    pub workspace_path: Option<String>,
    pub opencode_url: Option<String>,
    pub health_port: Option<u16>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

impl OpenCodeRouterManager {
    pub fn snapshot_locked(state: &mut OpenCodeRouterState) -> OpenCodeRouterInfo {
        let (running, pid) = match state.child.as_ref() {
            None => (false, None),
            Some(_child) if state.child_exited => {
                state.child = None;
                (false, None)
            }
            Some(child) => (true, Some(child.pid())),
        };

        OpenCodeRouterInfo {
            running,
            version: state.version.clone(),
            workspace_path: state.workspace_path.clone(),
            opencode_url: state.opencode_url.clone(),
            pid,
            last_stdout: state.last_stdout.clone(),
            last_stderr: state.last_stderr.clone(),
        }
    }

    pub fn stop_locked(state: &mut OpenCodeRouterState) {
        if let Some(child) = state.child.take() {
            let _ = child.kill();
        }
        state.child_exited = true;
        state.version = None;
        state.workspace_path = None;
        state.opencode_url = None;
        state.health_port = None;
        state.last_stdout = None;
        state.last_stderr = None;
    }
}
