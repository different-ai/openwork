use std::sync::{Arc, Mutex};

use tauri_plugin_shell::process::CommandChild;

use crate::types::{EngineInfo, EngineRuntime};

#[derive(Default)]
pub struct EngineManager {
    pub inner: Arc<Mutex<EngineState>>,
}

#[derive(Default)]
pub struct EngineState {
    pub runtime: EngineRuntime,
    pub child: Option<CommandChild>,
    pub child_exited: bool,
    pub project_dir: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub base_url: Option<String>,
    pub opencode_username: Option<String>,
    pub opencode_password: Option<String>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

impl EngineManager {
    pub fn snapshot_locked(state: &mut EngineState) -> EngineInfo {
        let (running, pid) = match state.child.as_ref() {
            None => (false, None),
            Some(_child) if state.child_exited => {
                state.child = None;
                (false, None)
            }
            Some(child) => (true, Some(child.pid())),
        };

        EngineInfo {
            running,
            runtime: state.runtime.clone(),
            base_url: state.base_url.clone(),
            project_dir: state.project_dir.clone(),
            hostname: state.hostname.clone(),
            port: state.port,
            opencode_username: state.opencode_username.clone(),
            opencode_password: state.opencode_password.clone(),
            pid,
            last_stdout: state.last_stdout.clone(),
            last_stderr: state.last_stderr.clone(),
        }
    }

    pub fn stop_locked(state: &mut EngineState) {
        if let Some(child) = state.child.take() {
            let _ = child.kill();
        }
        state.child_exited = true;
        state.runtime = EngineRuntime::Direct;
        state.base_url = None;
        state.project_dir = None;
        state.hostname = None;
        state.port = None;
        state.opencode_username = None;
        state.opencode_password = None;
        state.last_stdout = None;
        state.last_stderr = None;
    }
}
