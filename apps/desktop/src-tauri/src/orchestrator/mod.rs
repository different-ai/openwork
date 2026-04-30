use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::paths::home_dir;

pub mod manager;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorDaemonState {
    pub base_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStateFile {
    pub daemon: Option<OrchestratorDaemonState>,
}

pub fn resolve_orchestrator_data_dir() -> String {
    let env_dir = env::var("OPENWORK_DATA_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty());

    if let Some(dir) = env_dir {
        return dir;
    }

    if let Some(home) = home_dir() {
        return home
            .join(".openwork")
            .join("openwork-orchestrator")
            .to_string_lossy()
            .to_string();
    }

    ".openwork/openwork-orchestrator".to_string()
}

fn orchestrator_state_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("openwork-orchestrator-state.json")
}

fn orchestrator_auth_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("openwork-orchestrator-auth.json")
}

pub fn clear_orchestrator_auth(data_dir: &str) {
    let path = orchestrator_auth_path(data_dir);
    let _ = fs::remove_file(path);
}

pub fn read_orchestrator_state(data_dir: &str) -> Option<OrchestratorStateFile> {
    let path = orchestrator_state_path(data_dir);
    let payload = fs::read_to_string(path).ok()?;
    serde_json::from_str(&payload).ok()
}

pub fn request_orchestrator_shutdown(data_dir: &str) -> Result<bool, String> {
    let base_url = read_orchestrator_state(data_dir)
        .and_then(|state| state.daemon.map(|daemon| daemon.base_url))
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty());

    let Some(base_url) = base_url else {
        return Ok(false);
    };

    let url = format!("{}/shutdown", base_url.trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(1500))
        .build();

    agent
        .post(&url)
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|e| format!("Failed to request orchestrator shutdown at {url}: {e}"))?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::request_orchestrator_shutdown;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use uuid::Uuid;

    #[test]
    fn request_shutdown_returns_false_without_state() {
        let dir = std::env::temp_dir().join(format!(
            "openwork-orchestrator-shutdown-missing-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create test dir");

        let stopped = request_orchestrator_shutdown(&dir.to_string_lossy()).expect("request");
        assert!(!stopped);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn request_shutdown_posts_to_daemon_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind shutdown listener");
        let port = listener.local_addr().expect("listener addr").port();

        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept shutdown request");
            let mut buffer = [0u8; 2048];
            let bytes = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..bytes]);
            assert!(request.starts_with("POST /shutdown "));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                )
                .expect("write response");
        });

        let dir = std::env::temp_dir().join(format!(
            "openwork-orchestrator-shutdown-state-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create state dir");
        let state_path = dir.join("openwork-orchestrator-state.json");
        fs::write(
            &state_path,
            format!(
                "{{\"daemon\":{{\"pid\":1,\"port\":{port},\"baseUrl\":\"http://127.0.0.1:{port}\",\"startedAt\":1}}}}"
            ),
        )
        .expect("write state file");

        let stopped = request_orchestrator_shutdown(&dir.to_string_lossy()).expect("request");
        assert!(stopped);

        handle.join().expect("server thread");
        let _ = fs::remove_dir_all(dir);
    }
}
