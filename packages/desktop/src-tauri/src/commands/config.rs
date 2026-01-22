use crate::config::{read_opencode_config as read_inner, write_opencode_config as write_inner};
use crate::types::{ExecResult, OpencodeConfigFile};

#[tauri::command]
pub fn read_opencode_config(scope: String, project_dir: String) -> Result<OpencodeConfigFile, String> {
  read_inner(scope.trim(), &project_dir)
}

#[tauri::command]
pub fn write_opencode_config(
  scope: String,
  project_dir: String,
  content: String,
) -> Result<ExecResult, String> {
  write_inner(scope.trim(), &project_dir, &content)
}
