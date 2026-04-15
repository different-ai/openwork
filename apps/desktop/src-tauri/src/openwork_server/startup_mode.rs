#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerStartupMode {
    ServerV2,
}

pub fn resolve_server_startup_mode() -> ServerStartupMode {
    ServerStartupMode::ServerV2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_mode_defaults_to_server_v2() {
        assert_eq!(resolve_server_startup_mode(), ServerStartupMode::ServerV2);
    }
}
