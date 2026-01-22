use crate::types::UpdaterEnvironment;
use crate::updater::updater_environment as updater_environment_inner;

#[tauri::command]
pub fn updater_environment(_app: tauri::AppHandle) -> UpdaterEnvironment {
  updater_environment_inner()
}
