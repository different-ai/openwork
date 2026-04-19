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
        // Only act if we actually own a daemon process from this session. If we
        // never spawned one (or already stopped it), the state file's base_url
        // belongs to a previous run and POSTing to it would just log a spurious
        // "Connection refused".
        let Some(child) = state.child.take() else {
            state.data_dir = None;
            state.last_stdout = None;
            state.last_stderr = None;
            return;
        };

        let data_dir = state
            .data_dir
            .clone()
            .unwrap_or_else(orchestrator::resolve_orchestrator_data_dir);

        let shutdown_requested = match orchestrator::request_orchestrator_shutdown(&data_dir) {
            Ok(requested) => requested,
            Err(error) => {
                eprintln!("[orchestrator] Failed to request shutdown: {error}");
                false
            }
        };

        // Prefer daemon-owned graceful shutdown so openwork-orchestrator can
        // terminate its managed OpenCode child before exiting.
        if !shutdown_requested {
            let _ = child.kill();
        }

        orchestrator::clear_orchestrator_auth(&data_dir);
        state.child_exited = true;
        state.data_dir = None;
        state.last_stdout = None;
        state.last_stderr = None;
    }
}
