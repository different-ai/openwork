use std::sync::{Arc, Mutex};

use tauri_plugin_shell::process::CommandChild;

use crate::orchestrator;

#[derive(Default)]
pub struct OrchestratorManager {
    pub inner: Arc<Mutex<OrchestratorState>>,
}

#[derive(Default)]
pub struct OrchestratorState {
    pub child: Option<CommandChild>,
    pub child_exited: bool,
    pub data_dir: Option<String>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

impl OrchestratorManager {
    pub fn stop_locked(state: &mut OrchestratorState) {
        if let Some(child) = state.child.take() {
            let _ = child.kill();
        }
        if let Some(dir) = state.data_dir.as_deref() {
            orchestrator::clear_orchestrator_auth(dir);
        }
        state.child_exited = true;
        state.data_dir = None;
        state.last_stdout = None;
        state.last_stderr = None;
    }
}
