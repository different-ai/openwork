use std::fs;
use std::path::PathBuf;

use crate::types::{WorkspaceOpenworkConfig, WorkspaceTemplate};
use crate::utils::now_ms;

pub fn merge_plugins(existing: Vec<String>, required: &[&str]) -> Vec<String> {
  let mut out = existing;
  for plugin in required {
    if !out.iter().any(|entry| entry == plugin) {
      out.push(plugin.to_string());
    }
  }
  out
}

pub fn sanitize_template_id(raw: &str) -> Option<String> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return None;
  }

  let mut out = String::new();
  for ch in trimmed.chars() {
    if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
      out.push(ch);
    }
  }

  if out.is_empty() {
    return None;
  }

  Some(out)
}

fn seed_workspace_guide(skill_root: &PathBuf) -> Result<(), String> {
  let guide_dir = skill_root.join("workspace_guide");
  if guide_dir.exists() {
    return Ok(());
  }

  fs::create_dir_all(&guide_dir)
    .map_err(|e| format!("Failed to create {}: {e}", guide_dir.display()))?;

  let doc = r#"# Workspace Guide

This workspace is a real folder with local configuration.

## What lives where

- Workspace plugins: `opencode.json`
- Workspace skills: `.opencode/skill/*`
- Workspace templates: `.openwork/templates/*.json`
- OpenWork workspace metadata: `.opencode/openwork.json`

## What to try

- Run the template **Understand this workspace**
- Install a skill from the Skills tab
- Add a plugin in the Plugins tab

Be concise and practical."#;

  fs::write(guide_dir.join("SKILL.md"), doc)
    .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

  Ok(())
}

fn seed_templates(templates_dir: &PathBuf) -> Result<(), String> {
  if fs::read_dir(templates_dir)
    .map_err(|e| format!("Failed to read {}: {e}", templates_dir.display()))?
    .next()
    .is_some()
  {
    return Ok(());
  }

  let defaults = vec![
    WorkspaceTemplate {
      id: "tmpl_understand_workspace".to_string(),
      title: "Understand this workspace".to_string(),
      description: "Explains local vs global tools".to_string(),
      prompt: "Explain how this workspace is configured and what tools are available locally. Be concise and actionable.".to_string(),
      created_at: now_ms(),
    },
    WorkspaceTemplate {
      id: "tmpl_create_skill".to_string(),
      title: "Create a new skill".to_string(),
      description: "Guide to adding capabilities".to_string(),
      prompt: "I want to create a new skill for this workspace. Guide me through it.".to_string(),
      created_at: now_ms(),
    },
    WorkspaceTemplate {
      id: "tmpl_run_scheduled_task".to_string(),
      title: "Run a scheduled task".to_string(),
      description: "Demo of the scheduler plugin".to_string(),
      prompt: "Show me how to schedule a task to run every morning.".to_string(),
      created_at: now_ms(),
    },
    WorkspaceTemplate {
      id: "tmpl_task_to_template".to_string(),
      title: "Turn task into template".to_string(),
      description: "Save workflow for later".to_string(),
      prompt: "Help me turn the last task into a reusable template.".to_string(),
      created_at: now_ms(),
    },
  ];

  for template in defaults {
    let file_path = templates_dir.join(format!("{}.json", template.id));
    fs::write(
      &file_path,
      serde_json::to_string_pretty(&template).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", file_path.display()))?;
  }

  Ok(())
}

pub fn ensure_workspace_files(workspace_path: &str, preset: &str) -> Result<(), String> {
  let root = PathBuf::from(workspace_path);

  let skill_root = root.join(".opencode").join("skill");
  fs::create_dir_all(&skill_root)
    .map_err(|e| format!("Failed to create .opencode/skill: {e}"))?;
  seed_workspace_guide(&skill_root)?;

  let templates_dir = root.join(".openwork").join("templates");
  fs::create_dir_all(&templates_dir)
    .map_err(|e| format!("Failed to create .openwork/templates: {e}"))?;
  seed_templates(&templates_dir)?;

  let config_path = root.join("opencode.json");
  let mut config: serde_json::Value = if config_path.exists() {
    let raw = fs::read_to_string(&config_path)
      .map_err(|e| format!("Failed to read {}: {e}", config_path.display()))?;
    serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
  } else {
    serde_json::json!({
      "$schema": "https://opencode.ai/config.json"
    })
  };

  if !config.is_object() {
    config = serde_json::json!({
      "$schema": "https://opencode.ai/config.json"
    });
  }

  let required_plugins: Vec<&str> = match preset {
    "starter" => vec!["opencode-scheduler"],
    "automation" => vec!["opencode-scheduler"],
    _ => vec![],
  };

  if !required_plugins.is_empty() {
    let plugins_value = config
      .get("plugin")
      .cloned()
      .unwrap_or_else(|| serde_json::json!([]));

    let existing_plugins: Vec<String> = match plugins_value {
      serde_json::Value::Array(arr) => arr
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect(),
      serde_json::Value::String(s) => vec![s],
      _ => vec![],
    };

    let merged = merge_plugins(existing_plugins, &required_plugins);
    if let Some(obj) = config.as_object_mut() {
      obj.insert(
        "plugin".to_string(),
        serde_json::Value::Array(merged.into_iter().map(serde_json::Value::String).collect()),
      );
    }
  }

  fs::write(&config_path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
    .map_err(|e| format!("Failed to write {}: {e}", config_path.display()))?;

  let openwork_path = root.join(".opencode").join("openwork.json");
  if !openwork_path.exists() {
    let openwork = WorkspaceOpenworkConfig::new(workspace_path, preset, now_ms());

    fs::create_dir_all(openwork_path.parent().unwrap())
      .map_err(|e| format!("Failed to create {}: {e}", openwork_path.display()))?;

    fs::write(
      &openwork_path,
      serde_json::to_string_pretty(&openwork).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", openwork_path.display()))?;
  }

  Ok(())
}
