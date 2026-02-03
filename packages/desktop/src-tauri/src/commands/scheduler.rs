use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths::home_dir;
use crate::types::ScheduledJob;

fn scheduler_supported() -> bool {
  cfg!(target_os = "macos") || cfg!(target_os = "linux")
}

fn require_scheduler_support() -> Result<(), String> {
  if scheduler_supported() {
    return Ok(());
  }
  Err("Scheduler is supported only on macOS and Linux.".to_string())
}

fn opencode_jobs_dir() -> Result<PathBuf, String> {
  let Some(home) = home_dir() else {
    return Err("Failed to resolve home directory".to_string());
  };
  Ok(home.join(".config").join("opencode").join("jobs"))
}

fn load_job_file(path: &Path) -> Option<ScheduledJob> {
  let raw = fs::read_to_string(path).ok()?;
  serde_json::from_str(&raw).ok()
}

fn load_job_by_slug(jobs_dir: &Path, slug: &str) -> Option<ScheduledJob> {
  let trimmed = slug.trim();
  if trimmed.is_empty() {
    return None;
  }
  let path = jobs_dir.join(format!("{trimmed}.json"));
  if !path.is_file() {
    return None;
  }
  load_job_file(&path)
}

fn load_all_jobs(jobs_dir: &Path) -> Result<Vec<ScheduledJob>, String> {
  if !jobs_dir.exists() {
    return Ok(Vec::new());
  }

  let mut jobs = Vec::new();
  for entry in fs::read_dir(jobs_dir).map_err(|e| format!("Failed to read jobs dir: {e}"))? {
    let entry = entry.map_err(|e| e.to_string())?;
    let path = entry.path();
    if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
      continue;
    }
    if let Some(job) = load_job_file(&path) {
      jobs.push(job);
    }
  }

  jobs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  Ok(jobs)
}

fn slugify(name: &str) -> String {
  let mut out = String::new();
  let mut dash = false;
  for c in name.trim().to_lowercase().chars() {
    if c.is_ascii_alphanumeric() {
      out.push(c);
      dash = false;
      continue;
    }
    if !dash {
      out.push('-');
      dash = true;
    }
  }
  out.trim_matches('-').to_string()
}

fn find_job_by_name(jobs_dir: &Path, name: &str) -> Option<ScheduledJob> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return None;
  }

  let slug = slugify(trimmed);
  let mut job = load_job_by_slug(jobs_dir, &slug);
  if job.is_none() && slug != trimmed {
    job = load_job_by_slug(jobs_dir, trimmed);
  }

  if job.is_some() {
    return job;
  }

  let all = load_all_jobs(jobs_dir).ok()?;
  let lower = trimmed.to_lowercase();
  all.into_iter().find(|j| {
    j.slug == trimmed
      || j.slug.ends_with(&format!("-{slug}"))
      || j.name.to_lowercase() == lower
      || j.name.to_lowercase().contains(&lower)
  })
}

fn delete_job_file(jobs_dir: &Path, slug: &str) -> Result<(), String> {
  let path = jobs_dir.join(format!("{slug}.json"));
  if path.exists() {
    fs::remove_file(&path).map_err(|e| format!("Failed to remove job file: {e}"))?;
  }
  Ok(())
}

#[cfg(target_os = "macos")]
fn uninstall_job(slug: &str) -> Result<(), String> {
  let Some(home) = home_dir() else {
    return Err("Failed to resolve home directory".to_string());
  };

  let label = format!("com.opencode.job.{slug}");
  let plist = home
    .join("Library")
    .join("LaunchAgents")
    .join(format!("{label}.plist"));

  if plist.exists() {
    let _ = Command::new("launchctl").arg("unload").arg(&plist).output();
    fs::remove_file(&plist).map_err(|e| format!("Failed to remove plist: {e}"))?;
  }

  Ok(())
}

#[cfg(target_os = "linux")]
fn uninstall_job(slug: &str) -> Result<(), String> {
  let Some(home) = home_dir() else {
    return Err("Failed to resolve home directory".to_string());
  };

  let base = home.join(".config").join("systemd").join("user");
  let service = base.join(format!("opencode-job-{slug}.service"));
  let timer = base.join(format!("opencode-job-{slug}.timer"));

  let timer_unit = format!("opencode-job-{slug}.timer");
  let _ = Command::new("systemctl")
    .args(["--user", "stop", timer_unit.as_str()])
    .output();
  let _ = Command::new("systemctl")
    .args(["--user", "disable", timer_unit.as_str()])
    .output();

  if service.exists() {
    fs::remove_file(&service).map_err(|e| format!("Failed to remove service: {e}"))?;
  }
  if timer.exists() {
    fs::remove_file(&timer).map_err(|e| format!("Failed to remove timer: {e}"))?;
  }

  let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).output();
  Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn uninstall_job(_slug: &str) -> Result<(), String> {
  Err("Scheduler is supported only on macOS and Linux.".to_string())
}

#[tauri::command]
pub fn scheduler_list_jobs() -> Result<Vec<ScheduledJob>, String> {
  require_scheduler_support()?;
  let jobs_dir = opencode_jobs_dir()?;
  load_all_jobs(&jobs_dir)
}

#[tauri::command]
pub fn scheduler_delete_job(name: String) -> Result<ScheduledJob, String> {
  require_scheduler_support()?;
  let jobs_dir = opencode_jobs_dir()?;
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err("name is required".to_string());
  }

  let job = find_job_by_name(&jobs_dir, trimmed)
    .ok_or_else(|| format!("Job \"{trimmed}\" not found."))?;

  uninstall_job(&job.slug)?;
  delete_job_file(&jobs_dir, &job.slug)?;
  Ok(job)
}
