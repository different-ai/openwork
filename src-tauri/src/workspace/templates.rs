use std::fs;
use std::path::PathBuf;

use crate::types::WorkspaceTemplate;
use crate::workspace::files::sanitize_template_id;
use crate::workspace::state::default_template_created_at;

pub fn write_template(workspace_path: &str, template: WorkspaceTemplate) -> Result<PathBuf, String> {
  let Some(template_id) = sanitize_template_id(&template.id) else {
    return Err("template.id is required".to_string());
  };

  let templates_dir = PathBuf::from(workspace_path)
    .join(".openwork")
    .join("templates");

  fs::create_dir_all(&templates_dir)
    .map_err(|e| format!("Failed to create {}: {e}", templates_dir.display()))?;

  let payload = WorkspaceTemplate {
    id: template_id.clone(),
    title: template.title,
    description: template.description,
    prompt: template.prompt,
    created_at: default_template_created_at(template.created_at),
  };

  let file_path = templates_dir.join(format!("{}.json", template_id));
  fs::write(
    &file_path,
    serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?,
  )
  .map_err(|e| format!("Failed to write {}: {e}", file_path.display()))?;

  Ok(file_path)
}

pub fn delete_template(workspace_path: &str, template_id: &str) -> Result<PathBuf, String> {
  let Some(template_id) = sanitize_template_id(template_id) else {
    return Err("templateId is required".to_string());
  };

  let file_path = PathBuf::from(workspace_path)
    .join(".openwork")
    .join("templates")
    .join(format!("{}.json", template_id));

  if file_path.exists() {
    fs::remove_file(&file_path)
      .map_err(|e| format!("Failed to delete {}: {e}", file_path.display()))?;
  }

  Ok(file_path)
}
