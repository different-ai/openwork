use tauri::{AppHandle, State};

use crate::engine::manager::EngineManager;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::openwork_server::manager::OpenworkServerManager;
use crate::openwork_server::startup_mode::{resolve_server_startup_mode, ServerStartupMode};
use crate::openwork_server::{
    probe_server_v2_snapshot, start_openwork_server, start_openwork_server_v2,
};
use crate::types::{OpenworkServerInfo, WorkspaceType};
use crate::workspace::state::load_workspace_state;

#[tauri::command]
pub fn openwork_server_info(
    app: AppHandle,
    manager: State<OpenworkServerManager>,
) -> OpenworkServerInfo {
    eprintln!("[openwork-server][command] info requested");
    let mut state = manager
        .inner
        .lock()
        .expect("openwork server mutex poisoned");
    let snapshot = OpenworkServerManager::snapshot_locked(&mut state);
    drop(state);

    if snapshot.running || snapshot.base_url.is_some() {
        eprintln!(
            "[openwork-server][command] info returning live snapshot running={} base_url={:?} startup_mode={:?}",
            snapshot.running, snapshot.base_url, snapshot.startup_mode
        );
        return snapshot;
    }

    let probed = probe_server_v2_snapshot(&app, &manager)
        .ok()
        .flatten()
        .unwrap_or(snapshot);
    eprintln!(
        "[openwork-server][command] info returning probed snapshot running={} base_url={:?} startup_mode={:?}",
        probed.running, probed.base_url, probed.startup_mode
    );
    probed
}

#[tauri::command]
pub fn openwork_server_restart(
    app: AppHandle,
    manager: State<OpenworkServerManager>,
    engine_manager: State<EngineManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
    remote_access_enabled: Option<bool>,
) -> Result<OpenworkServerInfo, String> {
    eprintln!(
        "[openwork-server][command] restart requested remote_access_enabled={:?} startup_mode={:?}",
        remote_access_enabled,
        resolve_server_startup_mode()
    );
    if resolve_server_startup_mode() == ServerStartupMode::ServerV2 {
        if let Some(existing) = probe_server_v2_snapshot(&app, &manager)? {
            eprintln!(
                "[openwork-server][command] restart reused existing Server V2 instance base_url={:?} pid={:?}",
                existing.base_url, existing.pid
            );
            return Ok(existing);
        }
    }

    let (workspace_paths, opencode_url, opencode_username, opencode_password) = {
        let engine = engine_manager
            .inner
            .lock()
            .map_err(|_| "engine mutex poisoned".to_string())?;
        let mut workspace_paths = Vec::new();
        if let Some(project_dir) = engine.project_dir.clone() {
            let trimmed = project_dir.trim().to_string();
            if !trimmed.is_empty() {
                workspace_paths.push(trimmed);
            }
        }
        (
            workspace_paths,
            engine.base_url.clone(),
            engine.opencode_username.clone(),
            engine.opencode_password.clone(),
        )
    };

    let mut workspace_paths = workspace_paths;
    if workspace_paths.is_empty() {
        let state = load_workspace_state(&app)?;
        for workspace in state.workspaces {
            if workspace.workspace_type != WorkspaceType::Local {
                continue;
            }
            let trimmed = workspace.path.trim().to_string();
            if trimmed.is_empty() || workspace_paths.iter().any(|path| path == &trimmed) {
                continue;
            }
            workspace_paths.push(trimmed);
        }
    }
    let opencode_router_health_port = opencode_router_manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.health_port);

    eprintln!(
        "[openwork-server][command] restart resolved workspace_paths={:?} opencode_url={:?} router_health_port={:?}",
        workspace_paths, opencode_url, opencode_router_health_port
    );

    if resolve_server_startup_mode() == ServerStartupMode::ServerV2 {
        let info = start_openwork_server_v2(
            &app,
            &manager,
            &workspace_paths,
            remote_access_enabled.unwrap_or(false),
        )?;
        eprintln!(
            "[openwork-server][command] restart started Server V2 base_url={:?} pid={:?}",
            info.base_url, info.pid
        );
        return Ok(info);
    }

    let info = start_openwork_server(
        &app,
        &manager,
        &workspace_paths,
        opencode_url.as_deref(),
        opencode_username.as_deref(),
        opencode_password.as_deref(),
        opencode_router_health_port,
        remote_access_enabled.unwrap_or(false),
    )?;
    eprintln!(
        "[openwork-server][command] restart started legacy server base_url={:?} pid={:?}",
        info.base_url, info.pid
    );
    Ok(info)
}
