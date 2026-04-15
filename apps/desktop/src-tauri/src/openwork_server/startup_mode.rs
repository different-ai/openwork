#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerStartupMode {
    Legacy,
    ServerV2,
}

fn env_truthy(key: &str) -> Option<bool> {
    let value = std::env::var(key).ok()?;
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn resolve_server_startup_mode() -> ServerStartupMode {
    if env_truthy("OPENWORK_UI_USE_SERVER_V2") == Some(false) {
        ServerStartupMode::Legacy
    } else {
        ServerStartupMode::ServerV2
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn startup_mode_defaults_to_server_v2() {
        let _lock = ENV_LOCK.lock().expect("lock env");
        let _guard = EnvVarGuard::set("OPENWORK_UI_USE_SERVER_V2", "1");
        assert_eq!(resolve_server_startup_mode(), ServerStartupMode::ServerV2);
    }

    #[test]
    fn startup_mode_allows_legacy_override() {
        let _lock = ENV_LOCK.lock().expect("lock env");
        let _guard = EnvVarGuard::set("OPENWORK_UI_USE_SERVER_V2", "0");
        assert_eq!(resolve_server_startup_mode(), ServerStartupMode::Legacy);
    }
}
