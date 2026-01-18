use std::fs;
use std::path::Path;

pub fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
  if !src.is_dir() {
    return Err(format!("Source is not a directory: {}", src.display()));
  }

  fs::create_dir_all(dest).map_err(|e| format!("Failed to create dir {}: {e}", dest.display()))?;

  for entry in fs::read_dir(src).map_err(|e| format!("Failed to read dir {}: {e}", src.display()))? {
    let entry = entry.map_err(|e| e.to_string())?;
    let file_type = entry.file_type().map_err(|e| e.to_string())?;

    let from = entry.path();
    let to = dest.join(entry.file_name());

    if file_type.is_dir() {
      copy_dir_recursive(&from, &to)?;
      continue;
    }

    if file_type.is_file() {
      fs::copy(&from, &to)
        .map_err(|e| format!("Failed to copy {} -> {}: {e}", from.display(), to.display()))?;
      continue;
    }

    // Skip symlinks and other non-regular entries.
  }

  Ok(())
}
