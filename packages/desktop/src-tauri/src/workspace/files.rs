use std::fs;
use std::path::PathBuf;

use crate::types::{OpencodeCommand, WorkspaceOpenworkConfig};
use crate::utils::now_ms;
use crate::workspace::commands::{sanitize_command_name, serialize_command_frontmatter};

pub fn merge_plugins(existing: Vec<String>, required: &[&str]) -> Vec<String> {
  let mut out = existing;
  for plugin in required {
    if !out.iter().any(|entry| entry == plugin) {
      out.push(plugin.to_string());
    }
  }
  out
}

fn seed_workspace_guide(skill_root: &PathBuf) -> Result<(), String> {
  let guide_dir = skill_root.join("workspace-guide");
  if guide_dir.exists() {
    return Ok(());
  }

  fs::create_dir_all(&guide_dir)
    .map_err(|e| format!("Failed to create {}: {e}", guide_dir.display()))?;

  let doc = r#"---
name: workspace-guide
description: Workspace guide to introduce OpenWork and onboard new users.
---

# Welcome to OpenWork

Hi, I'm Ben and this is OpenWork. It's an open-source alternative to Claude's cowork. It helps you work on your files with AI and automate the mundane tasks so you don't have to.

Before we start, use the question tool to ask:
"Are you more technical or non-technical? I'll tailor the explanation."

## If the person is non-technical
OpenWork feels like a chat app, but it can safely work with the files you allow. Put files in this workspace and I can summarize them, create new ones, or help organize them.

Try:
- "Summarize the files in this workspace."
- "Create a checklist for my week."
- "Draft a short summary from this document."

## Skills and plugins (simple)
Skills add new capabilities. Plugins add advanced features like scheduling or browser automation. We can add them later when you're ready.

## If the person is technical
OpenWork is a GUI for OpenCode. Everything that works in OpenCode works here.

Most reliable setup today:
1) Install OpenCode from opencode.ai
2) Configure providers there (models and API keys)
3) Come back to OpenWork and start a session

Skills:
- Install from the Skills tab, or add them to this workspace.
- Docs: https://opencode.ai/docs/skills

Plugins:
- Configure in opencode.json or use the Plugins tab.
- Docs: https://opencode.ai/docs/plugins/

MCP servers:
- Add external tools via opencode.json.
- Docs: https://opencode.ai/docs/mcp-servers/

Config reference:
- Docs: https://opencode.ai/docs/config/

End with two friendly next actions to try in OpenWork."#;

  fs::write(guide_dir.join("SKILL.md"), doc)
    .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

  Ok(())
}

fn seed_commands(commands_dir: &PathBuf) -> Result<(), String> {
  if fs::read_dir(commands_dir)
    .map_err(|e| format!("Failed to read {}: {e}", commands_dir.display()))?
    .next()
    .is_some()
  {
    return Ok(());
  }

  let defaults = vec![
    OpencodeCommand {
      name: "learn-files".to_string(),
      description: Some("Safe, practical file workflows".to_string()),
      template: "Show me how to interact with files in this workspace. Include safe examples for reading, summarizing, and editing.".to_string(),
      agent: None,
      model: None,
      subtask: None,
    },
    OpencodeCommand {
      name: "learn-skills".to_string(),
      description: Some("How skills work and how to create your own".to_string()),
      template: "Explain what skills are, how to use them, and how to create a new skill for this workspace.".to_string(),
      agent: None,
      model: None,
      subtask: None,
    },
    OpencodeCommand {
      name: "learn-plugins".to_string(),
      description: Some("What plugins are and how to install them".to_string()),
      template: "Explain what plugins are and how to install them in this workspace.".to_string(),
      agent: None,
      model: None,
      subtask: None,
    },
  ];

  for command in defaults {
    let Some(name) = sanitize_command_name(&command.name) else {
      continue;
    };

    let file_path = commands_dir.join(format!("{name}.md"));
    let serialized = serialize_command_frontmatter(&command)?;
    fs::write(&file_path, serialized)
      .map_err(|e| format!("Failed to write {}: {e}", file_path.display()))?;
  }

  Ok(())
}

pub fn ensure_workspace_files(workspace_path: &str, preset: &str) -> Result<(), String> {
  let root = PathBuf::from(workspace_path);

  let skill_root = root.join(".opencode").join("skills");
  fs::create_dir_all(&skill_root)
    .map_err(|e| format!("Failed to create .opencode/skills: {e}"))?;
  seed_workspace_guide(&skill_root)?;

  let commands_dir = root.join(".opencode").join("commands");
  fs::create_dir_all(&commands_dir)
    .map_err(|e| format!("Failed to create .opencode/commands: {e}"))?;
  seed_commands(&commands_dir)?;

  let config_path_jsonc = root.join("opencode.jsonc");
  let config_path_json = root.join("opencode.json");
  let config_path = if config_path_jsonc.exists() {
    config_path_jsonc
  } else if config_path_json.exists() {
    config_path_json
  } else {
    config_path_jsonc
  };

  let config_exists = config_path.exists();
  let mut config_changed = !config_exists;
  let mut config: serde_json::Value = if config_exists {
    let raw = fs::read_to_string(&config_path)
      .map_err(|e| format!("Failed to read {}: {e}", config_path.display()))?;
    json5::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
  } else {
    serde_json::json!({
      "$schema": "https://opencode.ai/config.json"
    })
  };

  if !config.is_object() {
    config = serde_json::json!({
      "$schema": "https://opencode.ai/config.json"
    });
    config_changed = true;
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

    let merged = merge_plugins(existing_plugins.clone(), &required_plugins);
    if merged != existing_plugins {
      config_changed = true;
    }
    if let Some(obj) = config.as_object_mut() {
      obj.insert(
        "plugin".to_string(),
        serde_json::Value::Array(merged.into_iter().map(serde_json::Value::String).collect()),
      );
    }
  }

  if config_changed {
    fs::write(&config_path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
      .map_err(|e| format!("Failed to write {}: {e}", config_path.display()))?;
  }

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
