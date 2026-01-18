use tauri::Manager;

#[tauri::command]
pub fn reset_openwork_state(app: tauri::AppHandle, mode: String) -> Result<(), String> {
  let mode = mode.trim();
  if mode != "onboarding" && mode != "all" {
    return Err("mode must be 'onboarding' or 'all'".to_string());
  }

  let cache_dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?;

  if cache_dir.exists() {
    std::fs::remove_dir_all(&cache_dir)
      .map_err(|e| format!("Failed to remove cache dir {}: {e}", cache_dir.display()))?;
  }

  if mode == "all" {
    let data_dir = app
      .path()
      .app_data_dir()
      .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    if data_dir.exists() {
      std::fs::remove_dir_all(&data_dir)
        .map_err(|e| format!("Failed to remove data dir {}: {e}", data_dir.display()))?;
    }
  }

  Ok(())
}
