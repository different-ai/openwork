use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64
}

pub fn truncate_output(input: &str, max_chars: usize) -> String {
  if input.len() <= max_chars {
    return input.to_string();
  }

  input.chars().skip(input.chars().count() - max_chars).collect()
}
