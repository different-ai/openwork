use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::types::UpdaterEnvironment;
use crate::updater::updater_environment as updater_environment_inner;

const UPDATE_ENDPOINT_STABLE: &str =
    "https://github.com/different-ai/openwork/releases/latest/download/latest.json";
const UPDATE_RELEASES_API: &str =
    "https://api.github.com/repos/different-ai/openwork/releases?per_page=20";

#[derive(Default)]
pub struct PendingUpdateState {
    update: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    prerelease: bool,
    draft: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub current_version: String,
    pub date: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
}

fn normalize_channel(channel: Option<String>) -> String {
    match channel.as_deref() {
        Some("prerelease") => "prerelease".to_string(),
        _ => "stable".to_string(),
    }
}

fn fetch_prerelease_tag() -> Result<String, String> {
    let response = ureq::get(UPDATE_RELEASES_API)
        .set("User-Agent", "openwork-updater")
        .call()
        .map_err(|e| format!("Failed to load release list: {e}"))?;
    let releases: Vec<GitHubRelease> = response
        .into_json()
        .map_err(|e| format!("Failed to parse release list: {e}"))?;

    releases
        .into_iter()
        .find(|release| release.prerelease && !release.draft)
        .map(|release| release.tag_name)
        .ok_or_else(|| "No prerelease releases found.".to_string())
}

fn resolve_update_endpoint(channel: &str) -> Result<String, String> {
    if channel == "stable" {
        return Ok(UPDATE_ENDPOINT_STABLE.to_string());
    }

    let tag = fetch_prerelease_tag()?;
    Ok(format!(
        "https://github.com/different-ai/openwork/releases/download/{tag}/latest.json"
    ))
}

#[tauri::command]
pub fn updater_environment(_app: tauri::AppHandle) -> UpdaterEnvironment {
    updater_environment_inner()
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    channel: Option<String>,
    pending: State<'_, PendingUpdateState>,
) -> Result<Option<UpdateMetadata>, String> {
    let channel = normalize_channel(channel);
    let endpoint = Url::parse(&resolve_update_endpoint(&channel)?)
        .map_err(|e: url::ParseError| e.to_string())?;

    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let meta = update.as_ref().map(|update| UpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.map(|date| date.to_string()),
        notes: update.body.clone(),
    });

    *pending
        .update
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = update;
    *pending
        .bytes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;

    Ok(meta)
}

#[tauri::command]
pub async fn updater_download(
    pending: State<'_, PendingUpdateState>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let update = pending
        .update
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();

    let Some(update) = update else {
        return Err("No pending update.".to_string());
    };

    let mut started = false;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    *pending
        .bytes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bytes);
    Ok(())
}

#[tauri::command]
pub async fn updater_install(pending: State<'_, PendingUpdateState>) -> Result<(), String> {
    let update = pending
        .update
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    let bytes = pending
        .bytes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();

    let Some(update) = update else {
        return Err("No pending update.".to_string());
    };
    let Some(bytes) = bytes else {
        return Err("No downloaded update available.".to_string());
    };

    update.install(bytes).map_err(|e| e.to_string())?;
    Ok(())
}
