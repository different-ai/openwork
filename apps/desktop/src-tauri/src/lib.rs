mod bun_env;
mod commands;
mod config;
mod engine;
mod fs;
mod opencode_router;
mod openwork_server;
mod orchestrator;
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
use commands::engine::{
    engine_doctor, engine_info, engine_install, engine_restart, engine_start, engine_stop,
};
use commands::misc::{
    app_build_info, nuke_openwork_and_opencode_config_and_exit, opencode_mcp_auth,
    reset_opencode_cache, reset_openwork_state,
};
use commands::opencode_router::{
    opencodeRouter_config_set, opencodeRouter_info, opencodeRouter_start, opencodeRouter_status,
    opencodeRouter_stop,
};
use commands::openwork_server::{openwork_server_info, openwork_server_restart};
use commands::orchestrator::{
    orchestrator_instance_dispose, orchestrator_start_detached, orchestrator_status,
    orchestrator_workspace_activate, sandbox_cleanup_openwork_containers, sandbox_debug_probe,
    sandbox_doctor, sandbox_stop,
};
use commands::scheduler::{scheduler_delete_job, scheduler_list_jobs};
use commands::skills::{
    import_skill, install_skill_template, list_local_skills, read_local_skill, uninstall_skill,
    write_local_skill,
};
use commands::updater::updater_environment;
use commands::window::set_window_decorations;
use commands::workspace::{
    workspace_add_authorized_root, workspace_bootstrap, workspace_create, workspace_create_remote,
    workspace_export_config, workspace_forget, workspace_import_config, workspace_openwork_read,
    workspace_openwork_write, workspace_set_active, workspace_set_runtime_active,
    workspace_set_selected, workspace_update_display_name, workspace_update_remote,
};
use engine::manager::EngineManager;
use opencode_router::manager::OpenCodeRouterManager;
use openwork_server::manager::OpenworkServerManager;
use orchestrator::manager::OrchestratorManager;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use workspace::watch::WorkspaceWatchState;

const NATIVE_DEEP_LINK_EVENT: &str = "openwork:deep-link-native";

#[cfg(target_os = "macos")]
fn set_dev_app_name() {
    if std::env::var("OPENWORK_DEV_MODE").ok().as_deref() != Some("1") {
        return;
    }

    let Some(_mtm) = objc2::MainThreadMarker::new() else {
        return;
    };

    objc2_foundation::NSProcessInfo::processInfo()
        .setProcessName(&objc2_foundation::NSString::from_str("OpenWork - Dev"));
}

#[cfg(not(target_os = "macos"))]
fn set_dev_app_name() {}

fn forwarded_deep_links(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter_map(|arg| {
            let trimmed = arg.trim();
            if trimmed.starts_with("openwork://")
                || trimmed.starts_with("openwork-dev://")
                || trimmed.starts_with("https://")
                || trimmed.starts_with("http://")
            {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn emit_native_deep_links(app_handle: &AppHandle, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }

    let _ = app_handle.emit(NATIVE_DEEP_LINK_EVENT, urls);
}

fn emit_forwarded_deep_links(app_handle: &AppHandle, args: &[String]) {
    let urls = forwarded_deep_links(args);
    emit_native_deep_links(app_handle, urls);
}

fn show_main_window(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn stop_managed_services(app_handle: &tauri::AppHandle) {
    if let Ok(mut engine) = app_handle.state::<EngineManager>().inner.lock() {
        EngineManager::stop_locked(&mut engine);
    }
    if let Ok(mut orchestrator) = app_handle.state::<OrchestratorManager>().inner.lock() {
        OrchestratorManager::stop_locked(&mut orchestrator);
    }
    if let Ok(mut openwork_server) = app_handle.state::<OpenworkServerManager>().inner.lock() {
        OpenworkServerManager::stop_locked(&mut openwork_server);
    }
    if let Ok(mut opencode_router) = app_handle.state::<OpenCodeRouterManager>().inner.lock() {
        OpenCodeRouterManager::stop_locked(&mut opencode_router);
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main_window(app);
            emit_forwarded_deep_links(app, &args);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let app = builder
        .setup(|_| {
            set_dev_app_name();
            Ok(())
        })
        .manage(EngineManager::default())
        .manage(OrchestratorManager::default())
        .manage(OpenworkServerManager::default())
        .manage(OpenCodeRouterManager::default())
        .manage(WorkspaceWatchState::default())
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_stop,
            engine_info,
            engine_doctor,
            engine_install,
            engine_restart,
            orchestrator_status,
            orchestrator_workspace_activate,
            orchestrator_instance_dispose,
            orchestrator_start_detached,
            sandbox_doctor,
            sandbox_debug_probe,
            sandbox_stop,
            sandbox_cleanup_openwork_containers,
            openwork_server_info,
            openwork_server_restart,
            opencodeRouter_info,
            opencodeRouter_start,
            opencodeRouter_stop,
            opencodeRouter_status,
            opencodeRouter_config_set,
            workspace_bootstrap,
            workspace_set_selected,
            workspace_set_runtime_active,
            workspace_set_active,
            workspace_create,
            workspace_create_remote,
            workspace_update_display_name,
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
            import_skill,
            install_skill_template,
            list_local_skills,
            read_local_skill,
            uninstall_skill,
            write_local_skill,
            read_opencode_config,
            write_opencode_config,
            updater_environment,
            app_build_info,
            nuke_openwork_and_opencode_config_and_exit,
            reset_openwork_state,
            reset_opencode_cache,
            opencode_mcp_auth,
            scheduler_list_jobs,
            scheduler_delete_job,
            set_window_decorations
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpenWork");

    // Best-effort cleanup on app exit. Without this, background sidecars can keep
    // running after the UI quits (especially during dev), leading to multiple
    // orchestrator/opencode/openwork-server processes and stale ports.
    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => stop_managed_services(&app_handle),
        #[cfg(target_os = "macos")]
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            hide_main_window(&app_handle);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let urls = urls
                .into_iter()
                .map(|url| url.to_string())
                .collect::<Vec<_>>();
            show_main_window(&app_handle);
            emit_native_deep_links(&app_handle, urls);
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                show_main_window(&app_handle);
            }
        }
        _ => {}
    });
}
