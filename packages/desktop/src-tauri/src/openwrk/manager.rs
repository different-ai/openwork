use std::sync::{Arc, Mutex};

use tauri_plugin_shell::process::CommandChild;

#[derive(Default)]
pub struct OpenwrkManager {
    pub inner: Arc<Mutex<OpenwrkState>>,
}

#[derive(Default)]
pub struct OpenwrkState {
    pub child: Option<CommandChild>,
    pub child_exited: bool,
    pub data_dir: Option<String>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

impl OpenwrkManager {
    pub fn stop_locked(state: &mut OpenwrkState) {
        if let Some(child) = state.child.take() {
            let _ = child.kill();
        }
        state.child_exited = true;
        state.last_stdout = None;
        state.last_stderr = None;
    }
}
