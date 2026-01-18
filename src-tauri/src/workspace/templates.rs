use std::fs;
use std::path::PathBuf;

use crate::types::WorkspaceTemplate;
use crate::workspace::files::sanitize_template_id;
use crate::workspace::state::default_template_created_at;

pub fn serialize_template_frontmatter(template: &WorkspaceTemplate) -> Result<String, String> {
  fn escape_yaml_scalar(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
      match ch {
        '\\' => out.push_str("\\\\"),
        '"' => out.push_str("\\\""),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        _ => out.push(ch),
      }
    }
    out.push('"');
    out
  }

  let mut out = String::new();
  out.push_str("---\n");
  out.push_str(&format!("id: {}\n", escape_yaml_scalar(&template.id)));
  out.push_str(&format!("title: {}\n", escape_yaml_scalar(&template.title)));
  out.push_str(&format!(
    "description: {}\n",
    escape_yaml_scalar(&template.description),
  )));
  out.push_str(&format!("createdAt: {}\n", template.created_at));
  out.push_str("---\n\n");
  out.push_str(template.prompt.trim_end());
  out.push('\n');
  Ok(out)
}

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

  let template_dir = templates_dir.join(&template_id);
  fs::create_dir_all(&template_dir)
    .map_err(|e| format!("Failed to create {}: {e}", template_dir.display()))?;

  let legacy_paths = [
    templates_dir.join(format!("{}.json", template_id)),
    templates_dir.join(format!("{}.yml", template_id)),
    templates_dir.join(format!("{}.yaml", template_id)),
  ];

  for legacy_path in legacy_paths {
    if legacy_path.exists() {
      fs::remove_file(&legacy_path)
        .map_err(|e| format!("Failed to delete {}: {e}", legacy_path.display()))?;
    }
  }

  let file_path = template_dir.join("template.yml");
  let serialized = serialize_template_frontmatter(&payload)?;
  fs::write(&file_path, serialized)
    .map_err(|e| format!("Failed to write {}: {e}", file_path.display()))?;

  Ok(file_path)
}

pub fn delete_template(workspace_path: &str, template_id: &str) -> Result<PathBuf, String> {
  let Some(template_id) = sanitize_template_id(template_id) else {
    return Err("templateId is required".to_string());
  };

  let templates_dir = PathBuf::from(workspace_path)
    .join(".openwork")
    .join("templates");

  let template_dir = templates_dir.join(&template_id);
  let mut removed_path = template_dir.join("template.yml");

  let candidate_paths = [
    template_dir.join("template.yml"),
    template_dir.join("template.yaml"),
    templates_dir.join(format!("{}.json", template_id)),
    templates_dir.join(format!("{}.yml", template_id)),
    templates_dir.join(format!("{}.yaml", template_id)),
  ];

  for candidate in candidate_paths {
    if candidate.exists() {
      removed_path = candidate.clone();
      fs::remove_file(&candidate)
        .map_err(|e| format!("Failed to delete {}: {e}", candidate.display()))?;
    }
  }

  if template_dir.exists() {
    if template_dir
      .read_dir()
      .map_err(|e| format!("Failed to read {}: {e}", template_dir.display()))?
      .next()
      .is_none()
    {
      fs::remove_dir(&template_dir)
        .map_err(|e| format!("Failed to remove {}: {e}", template_dir.display()))?;
    }
  }

  Ok(removed_path)
}
