#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerStartupMode {
    Legacy,
    ServerV2,
}

fn is_truthy_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn resolve_server_startup_mode() -> ServerStartupMode {
    match std::env::var("OPENWORK_UI_USE_SERVER_V2") {
        Ok(value) if is_truthy_flag(&value) => ServerStartupMode::ServerV2,
        _ => ServerStartupMode::Legacy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn reset_flag() {
        unsafe {
            std::env::remove_var("OPENWORK_UI_USE_SERVER_V2");
        }
    }

    #[test]
    fn startup_mode_defaults_to_legacy() {
        let _guard = env_lock().lock().unwrap();
        reset_flag();
        assert_eq!(resolve_server_startup_mode(), ServerStartupMode::Legacy);
    }

    #[test]
    fn startup_mode_allows_explicit_server_v2_opt_in() {
        let _guard = env_lock().lock().unwrap();
        unsafe {
            std::env::set_var("OPENWORK_UI_USE_SERVER_V2", "1");
        }
        assert_eq!(resolve_server_startup_mode(), ServerStartupMode::ServerV2);
        reset_flag();
    }
}
