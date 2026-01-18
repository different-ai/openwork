use std::process::Child;
use std::sync::{Arc, Mutex};

use crate::types::EngineInfo;

#[derive(Default)]
pub struct EngineManager {
  pub inner: Arc<Mutex<EngineState>>,
}

#[derive(Default)]
pub struct EngineState {
  pub child: Option<Child>,
  pub project_dir: Option<String>,
  pub hostname: Option<String>,
  pub port: Option<u16>,
  pub base_url: Option<String>,
  pub last_stdout: Option<String>,
  pub last_stderr: Option<String>,
}

impl EngineManager {
  pub fn snapshot_locked(state: &mut EngineState) -> EngineInfo {
    let (running, pid) = match state.child.as_mut() {
      None => (false, None),
      Some(child) => match child.try_wait() {
        Ok(Some(_status)) => {
          state.child = None;
          (false, None)
        }
        Ok(None) => (true, Some(child.id())),
        Err(_) => (true, Some(child.id())),
      },
    };

    EngineInfo {
      running,
      base_url: state.base_url.clone(),
      project_dir: state.project_dir.clone(),
      hostname: state.hostname.clone(),
      port: state.port,
      pid,
      last_stdout: state.last_stdout.clone(),
      last_stderr: state.last_stderr.clone(),
    }
  }

  pub fn stop_locked(state: &mut EngineState) {
    if let Some(mut child) = state.child.take() {
      let _ = child.kill();
      let _ = child.wait();
    }
    state.base_url = None;
    state.project_dir = None;
    state.hostname = None;
    state.port = None;
    state.last_stdout = None;
    state.last_stderr = None;
  }
}
