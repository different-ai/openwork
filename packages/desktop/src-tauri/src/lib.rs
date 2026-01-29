mod commands;
mod config;
mod engine;
mod fs;
mod opkg;
mod openwork_server;
mod owpenbot;
mod paths;
mod platform;
mod types;
mod updater;
mod utils;
mod workspace;

pub use types::*;

use commands::command_files::{
    opencode_command_delete, opencode_command_list, opencode_command_write,
};
use commands::config::{read_opencode_config, write_opencode_config};
use commands::engine::{engine_doctor, engine_info, engine_install, engine_start, engine_stop};
use commands::misc::{opencode_mcp_auth, reset_opencode_cache, reset_openwork_state};
use commands::openwork_server::openwork_server_info;
use commands::opkg::{import_skill, opkg_install};
use commands::owpenbot::{
    owpenbot_config_set, owpenbot_info, owpenbot_pairing_approve, owpenbot_pairing_deny,
    owpenbot_pairing_list, owpenbot_qr, owpenbot_start, owpenbot_status, owpenbot_stop,
};
use commands::skills::{install_skill_template, list_local_skills, uninstall_skill};
use commands::updater::updater_environment;
use commands::workspace::{
    workspace_add_authorized_root, workspace_bootstrap, workspace_create, workspace_create_remote,
    workspace_export_config, workspace_forget, workspace_import_config, workspace_openwork_read,
    workspace_openwork_write, workspace_set_active, workspace_update_remote,
};
use engine::manager::EngineManager;
use openwork_server::manager::OpenworkServerManager;
use owpenbot::manager::OwpenbotManager;
use workspace::watch::WorkspaceWatchState;

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .manage(EngineManager::default())
        .manage(OpenworkServerManager::default())
        .manage(OwpenbotManager::default())
        .manage(WorkspaceWatchState::default())
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_stop,
            engine_info,
            engine_doctor,
            engine_install,
            openwork_server_info,
            owpenbot_info,
            owpenbot_start,
            owpenbot_stop,
            owpenbot_qr,
            owpenbot_status,
            owpenbot_config_set,
            owpenbot_pairing_list,
            owpenbot_pairing_approve,
            owpenbot_pairing_deny,
            workspace_bootstrap,
            workspace_set_active,
            workspace_create,
            workspace_create_remote,
            workspace_update_remote,
            workspace_forget,
            workspace_add_authorized_root,
            workspace_export_config,
            workspace_import_config,
            opencode_command_list,
            opencode_command_write,
            opencode_command_delete,
            workspace_openwork_read,
            workspace_openwork_write,
            opkg_install,
            import_skill,
            install_skill_template,
            list_local_skills,
            uninstall_skill,
            read_opencode_config,
            write_opencode_config,
            updater_environment,
            reset_openwork_state,
            reset_opencode_cache,
            opencode_mcp_auth
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenWork");
}
