use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MIGRATION_SNAPSHOT_FILENAME: &str = "migration-snapshot.v1.json";

#[derive(Debug, Deserialize)]
pub struct MigrationSnapshotPayload {
    pub version: u32,
    #[serde(rename = "writtenAt")]
    pub written_at: Option<i64>,
    pub source: Option<String>,
    pub keys: HashMap<String, String>,
}

fn migration_snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create app_data_dir: {e}"))?;
    Ok(data_dir.join(MIGRATION_SNAPSHOT_FILENAME))
}

/// Snapshot workspace-related localStorage keys into app_data_dir so the
/// next-launch Electron shell can hydrate them. Called by the last Tauri
/// release right before it kicks off the Electron installer.
#[tauri::command]
pub fn write_migration_snapshot(
    app: AppHandle,
    snapshot: MigrationSnapshotPayload,
) -> Result<(), String> {
    if snapshot.version != 1 {
        return Err(format!(
            "Unsupported migration snapshot version: {}",
            snapshot.version
        ));
    }

    let path = migration_snapshot_path(&app)?;
    let serialized = serde_json::json!({
        "version": snapshot.version,
        "writtenAt": snapshot.written_at,
        "source": snapshot.source.unwrap_or_else(|| "tauri".to_string()),
        "keys": snapshot.keys,
    });
    let contents = serde_json::to_string_pretty(&serialized)
        .map_err(|e| format!("Failed to serialize snapshot: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Failed to write snapshot: {e}"))?;

    println!(
        "[migration] wrote {} key(s) to {}",
        snapshot.keys.len(),
        path.display()
    );

    Ok(())
}
