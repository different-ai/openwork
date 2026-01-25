use crate::types::OpencodeCommand;

pub fn sanitize_command_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('/');
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

pub fn serialize_command_frontmatter(command: &OpencodeCommand) -> Result<String, String> {
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

    let template = command.template.trim();
    if template.is_empty() {
        return Err("command.template is required".to_string());
    }

    let mut out = String::new();
    out.push_str("---\n");
    if let Some(description) = command.description.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        out.push_str(&format!("description: {}\n", escape_yaml_scalar(description)));
    }
    if let Some(agent) = command.agent.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        out.push_str(&format!("agent: {}\n", escape_yaml_scalar(agent)));
    }
    if let Some(model) = command.model.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        out.push_str(&format!("model: {}\n", escape_yaml_scalar(model)));
    }
    if command.subtask.unwrap_or(false) {
        out.push_str("subtask: true\n");
    }
    out.push_str("---\n\n");
    out.push_str(template);
    out.push('\n');
    Ok(out)
}
