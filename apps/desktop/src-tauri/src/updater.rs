use std::path::Path;

use crate::types::UpdaterEnvironment;

fn is_mac_dmg_or_translocated(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    path_str.contains("/Volumes/") || path_str.contains("AppTranslocation")
}

#[cfg(target_os = "linux")]
fn linux_updater_is_supported(executable_path: Option<&Path>) -> bool {
    if std::env::var_os("APPIMAGE").is_some() {
        return true;
    }

    let Some(exe) = executable_path else {
        return false;
    };

    exe.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.ends_with(".AppImage"))
        .unwrap_or(false)
}

pub fn updater_environment() -> UpdaterEnvironment {
    let executable_path = std::env::current_exe().ok();

    let app_bundle_path = executable_path
        .as_ref()
        .and_then(|exe| exe.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());

    let mut supported = true;
    let mut reason: Option<String> = None;

    if let Some(exe) = executable_path.as_ref() {
        if is_mac_dmg_or_translocated(exe) {
            supported = false;
            reason = Some(
                "OpenWork is running from a mounted disk image. Install it to Applications to enable updates."
                    .to_string(),
            );
        }
    }

    if supported {
        if let Some(bundle) = app_bundle_path.as_ref() {
            if is_mac_dmg_or_translocated(bundle) {
                supported = false;
                reason = Some(
                    "OpenWork is running from a mounted disk image. Install it to Applications to enable updates."
                        .to_string(),
                );
            }
        }
    }

    #[cfg(target_os = "linux")]
    if supported && !linux_updater_is_supported(executable_path.as_deref()) {
        supported = false;
        reason = Some(
            "OpenWork auto-update on Linux requires the AppImage build. Install updates via your package manager for .deb/.rpm installs."
                .to_string(),
        );
    }

    UpdaterEnvironment {
        supported,
        reason,
        executable_path: executable_path.map(|p| p.to_string_lossy().to_string()),
        app_bundle_path: app_bundle_path.map(|p| p.to_string_lossy().to_string()),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux_updater_is_supported;
    use std::path::Path;

    #[test]
    fn supports_appimage_path() {
        assert!(linux_updater_is_supported(Some(Path::new(
            "/opt/OpenWork/OpenWork-x86_64.AppImage"
        ))));
    }

    #[test]
    fn rejects_non_appimage_without_env() {
        assert!(!linux_updater_is_supported(Some(Path::new(
            "/usr/bin/openwork"
        ))));
    }
}
