use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::types::{WorkspaceInfo, WorkspaceType};

const RELOAD_EVENT: &str = "openwork://reload-required";

#[derive(Default)]
pub struct WorkspaceWatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_emit: Arc<Mutex<Option<Instant>>>,
    root: Mutex<Option<PathBuf>>,
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn reason_for_path(path: &Path) -> Option<&'static str> {
    let normalized = normalize_path(path);
    let lower = normalized.to_lowercase();
    if lower.contains("/.opencode/skills/") || lower.ends_with("/.opencode/skills") {
        return Some("skills");
    }
    if lower.contains("/.opencode/") || lower.ends_with("/.opencode") {
        return Some("config");
    }
    if lower.ends_with("/opencode.json") || lower.ends_with("/opencode.jsonc") {
        return Some("config");
    }
    None
}

fn should_emit(last_emit: &Arc<Mutex<Option<Instant>>>) -> bool {
    let mut guard = last_emit
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    if let Some(previous) = *guard {
        if now.duration_since(previous) < Duration::from_millis(750) {
            return false;
        }
    }
    *guard = Some(now);
    true
}

pub fn update_workspace_watch(
    app: &AppHandle,
    state: State<WorkspaceWatchState>,
    workspace: Option<&WorkspaceInfo>,
) -> Result<(), String> {
    let mut watcher_guard = state
        .watcher
        .lock()
        .map_err(|_| "Failed to lock workspace watcher".to_string())?;
    *watcher_guard = None;
    *state
        .root
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;

    let Some(active) = workspace else {
        return Ok(());
    };
    if active.workspace_type != WorkspaceType::Local {
        return Ok(());
    }

    let root = PathBuf::from(active.path.trim());
    if root.as_os_str().is_empty() {
        return Ok(());
    }

    let app_handle = app.clone();
    let last_emit = state.last_emit.clone();
    let mut watcher = notify::recommended_watcher(move |result| {
        let event: Event = match result {
            Ok(event) => event,
            Err(_) => return,
        };

        match event.kind {
            EventKind::Create(_) | EventKind::Remove(_) => {}
            EventKind::Modify(mod_kind) => match mod_kind {
                notify::event::ModifyKind::Data(_)
                | notify::event::ModifyKind::Name(_)
                | notify::event::ModifyKind::Any => {}
                _ => return,
            },
            _ => return,
        }

        for path in event.paths {
            if path.is_dir() {
                continue;
            }

            let Some(reason) = reason_for_path(&path) else {
                continue;
            };

            let lower = path.to_string_lossy().to_lowercase();
            if lower.ends_with(".ds_store")
                || lower.ends_with("desktop.ini")
                || lower.ends_with(".localized")
            {
                continue;
            }

            if !should_emit(&last_emit) {
                break;
            }
            let payload = json!({
                "reason": reason,
                "path": path.to_string_lossy().to_string(),
            });
            let _ = app_handle.emit(RELOAD_EVENT, payload);
            break;
        }
    })
    .map_err(|e| format!("Failed to create workspace watcher: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch workspace root: {e}"))?;

    let opencode_dir = root.join(".opencode");
    if opencode_dir.exists() {
        watcher
            .watch(&opencode_dir, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch .opencode: {e}"))?;
    }

    *state
        .root
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(root);
    *watcher_guard = Some(watcher);
    Ok(())
}
