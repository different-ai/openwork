use crate::desktop_bootstrap::{
    read_or_init_desktop_bootstrap_config, save_desktop_bootstrap_config,
};
use crate::types::DesktopBootstrapConfig;

#[tauri::command]
pub fn get_desktop_bootstrap_config() -> Result<DesktopBootstrapConfig, String> {
    read_or_init_desktop_bootstrap_config()
}

#[tauri::command]
pub fn set_desktop_bootstrap_config(
    config: DesktopBootstrapConfig,
) -> Result<DesktopBootstrapConfig, String> {
    save_desktop_bootstrap_config(&config)
}
