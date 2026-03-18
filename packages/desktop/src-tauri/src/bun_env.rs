const SAFE_DNS_RESULT_ORDER: &str = "verbatim";

fn is_valid_dns_result_order(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized == "ipv4first" || normalized == "verbatim"
}

fn sanitize_dns_result_order_args(raw: &str) -> Option<String> {
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let mut kept = Vec::new();
    let mut changed = false;
    let mut index = 0usize;

    while index < tokens.len() {
        let token = tokens[index];

        if let Some(order) = token.strip_prefix("--dns-result-order=") {
            if is_valid_dns_result_order(order) {
                kept.push(token.to_string());
            } else {
                changed = true;
            }
            index += 1;
            continue;
        }

        if token == "--dns-result-order" {
            match tokens.get(index + 1).copied() {
                Some(order) if is_valid_dns_result_order(order) => {
                    kept.push(token.to_string());
                    kept.push(order.to_string());
                }
                Some(_) | None => {
                    changed = true;
                }
            }
            index += 2;
            continue;
        }

        kept.push(token.to_string());
        index += 1;
    }

    if !changed {
        return None;
    }

    Some(kept.join(" "))
}

pub fn bun_env_overrides() -> Vec<(&'static str, String)> {
    let mut overrides = vec![(
        "BUN_CONFIG_DNS_RESULT_ORDER",
        SAFE_DNS_RESULT_ORDER.to_string(),
    )];

    if let Ok(value) = std::env::var("BUN_OPTIONS") {
        if let Some(sanitized) = sanitize_dns_result_order_args(&value) {
            overrides.push(("BUN_OPTIONS", sanitized));
        }
    }

    if let Ok(value) = std::env::var("NODE_OPTIONS") {
        if let Some(sanitized) = sanitize_dns_result_order_args(&value) {
            overrides.push(("NODE_OPTIONS", sanitized));
        }
    }

    overrides
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

        fn clear(key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            std::env::remove_var(key);
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
    fn strips_invalid_dns_result_order_from_bun_options() {
        let _lock = ENV_LOCK.lock().expect("lock env");
        let _bun_options =
            EnvVarGuard::set("BUN_OPTIONS", "--smol --dns-result-order=ipv6first --hot");
        let _node_options = EnvVarGuard::clear("NODE_OPTIONS");

        let overrides = bun_env_overrides();
        let bun_override = overrides
            .iter()
            .find(|(key, _)| *key == "BUN_OPTIONS")
            .map(|(_, value)| value.clone());

        assert_eq!(bun_override.as_deref(), Some("--smol --hot"));
    }

    #[test]
    fn strips_invalid_split_dns_result_order_from_node_options() {
        let _lock = ENV_LOCK.lock().expect("lock env");
        let _bun_options = EnvVarGuard::clear("BUN_OPTIONS");
        let _node_options = EnvVarGuard::set(
            "NODE_OPTIONS",
            "--max-old-space-size=4096 --dns-result-order weird",
        );

        let overrides = bun_env_overrides();
        let node_override = overrides
            .iter()
            .find(|(key, _)| *key == "NODE_OPTIONS")
            .map(|(_, value)| value.clone());

        assert_eq!(node_override.as_deref(), Some("--max-old-space-size=4096"));
    }

    #[test]
    fn keeps_valid_dns_result_order_flags() {
        let _lock = ENV_LOCK.lock().expect("lock env");
        let _bun_options = EnvVarGuard::set("BUN_OPTIONS", "--dns-result-order=ipv4first");
        let _node_options = EnvVarGuard::set("NODE_OPTIONS", "--dns-result-order verbatim");

        let overrides = bun_env_overrides();

        assert!(!overrides.iter().any(|(key, _)| *key == "BUN_OPTIONS"));
        assert!(!overrides.iter().any(|(key, _)| *key == "NODE_OPTIONS"));
    }
}
