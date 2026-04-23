use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

// User-level env file. Matched byte-for-byte by:
//   apps/server/src/env-file.ts             (CRUD + server routes)
//   apps/desktop/electron/runtime.mjs       (Electron spawn)
//   apps/orchestrator/src/cli.ts            (orchestrator spawn)
// If any of those change their path resolution or reserved-prefix policy,
// update this file in the same PR.

const RESERVED_PREFIXES: &[&str] = &["OPENWORK_", "OPENCODE_"];

#[derive(Debug, Deserialize)]
struct EnvFile {
    #[serde(default)]
    variables: Vec<EnvRecord>,
}

#[derive(Debug, Deserialize)]
struct EnvRecord {
    key: String,
    value: String,
}

fn resolve_user_env_file_path() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("OPENWORK_ENV_STORE") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let root = std::env::var("APPDATA")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join("AppData").join("Roaming")));
        return root.map(|base| base.join("openwork").join("env.json"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        dirs::home_dir().map(|home| home.join(".config").join("openwork").join("env.json"))
    }
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_reserved_env_key(key: &str) -> bool {
    RESERVED_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

/// Best-effort load of the user-level env file. Absent, unreadable, or
/// malformed files return an empty vector; reserved-prefix keys are always
/// stripped so a tampered file cannot shadow OpenWork / OpenCode internals.
pub fn load_user_env_file() -> Vec<(String, String)> {
    let Some(path) = resolve_user_env_file_path() else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<EnvFile>(&raw) else {
        return Vec::new();
    };
    parsed
        .variables
        .into_iter()
        .filter(|record| is_valid_env_key(&record.key) && !is_reserved_env_key(&record.key))
        .map(|record| (record.key, record.value))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());
    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn unique_env_path() -> PathBuf {
        let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir()
            .join(format!("openwork-env-file-{epoch}-{nonce}"));
        fs::create_dir_all(&dir).expect("mkdir tmp");
        dir.join("env.json")
    }

    struct EnvStoreGuard {
        path: PathBuf,
        original: Option<String>,
    }

    impl EnvStoreGuard {
        fn set(path: PathBuf) -> Self {
            let original = std::env::var("OPENWORK_ENV_STORE").ok();
            std::env::set_var("OPENWORK_ENV_STORE", &path);
            Self { path, original }
        }
    }

    impl Drop for EnvStoreGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var("OPENWORK_ENV_STORE", value),
                None => std::env::remove_var("OPENWORK_ENV_STORE"),
            }
            if let Some(parent) = self.path.parent() {
                let _ = fs::remove_dir_all(parent);
            }
        }
    }

    #[test]
    fn returns_empty_when_file_is_missing() {
        let _lock = ENV_LOCK.lock().expect("lock");
        let path = unique_env_path();
        let _guard = EnvStoreGuard::set(path);
        assert!(load_user_env_file().is_empty());
    }

    #[test]
    fn returns_empty_on_invalid_json() {
        let _lock = ENV_LOCK.lock().expect("lock");
        let path = unique_env_path();
        fs::write(&path, "{ not json").expect("write");
        let _guard = EnvStoreGuard::set(path);
        assert!(load_user_env_file().is_empty());
    }

    #[test]
    fn loads_well_formed_entries() {
        let _lock = ENV_LOCK.lock().expect("lock");
        let path = unique_env_path();
        fs::write(
            &path,
            r#"{"schemaVersion":1,"updatedAt":0,"variables":[
                {"key":"ANTHROPIC_API_KEY","value":"sk-ant","updatedAt":0},
                {"key":"GCLOUD_PROJECT","value":"p","updatedAt":0}
            ]}"#,
        )
        .expect("write");
        let _guard = EnvStoreGuard::set(path);
        let loaded = load_user_env_file();
        assert_eq!(loaded.len(), 2);
        assert!(
            loaded
                .iter()
                .any(|(k, v)| k == "ANTHROPIC_API_KEY" && v == "sk-ant")
        );
    }

    #[test]
    fn strips_reserved_and_malformed_keys() {
        let _lock = ENV_LOCK.lock().expect("lock");
        let path = unique_env_path();
        fs::write(
            &path,
            r#"{"schemaVersion":1,"updatedAt":0,"variables":[
                {"key":"OPENWORK_TOKEN","value":"stolen","updatedAt":0},
                {"key":"OPENCODE_SERVER_PASSWORD","value":"stolen","updatedAt":0},
                {"key":"has-dash","value":"nope","updatedAt":0},
                {"key":"1BAD","value":"nope","updatedAt":0},
                {"key":"ANTHROPIC_API_KEY","value":"ok","updatedAt":0}
            ]}"#,
        )
        .expect("write");
        let _guard = EnvStoreGuard::set(path);
        let loaded = load_user_env_file();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].0, "ANTHROPIC_API_KEY");
    }
}
