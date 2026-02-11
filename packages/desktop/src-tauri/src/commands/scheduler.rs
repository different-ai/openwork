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

fn legacy_jobs_dir() -> Result<PathBuf, String> {
    let Some(home) = home_dir() else {
        return Err("Failed to resolve home directory".to_string());
    };
    Ok(home.join(".config").join("opencode").join("jobs"))
}

fn scheduler_scopes_dir() -> Result<PathBuf, String> {
    let Some(home) = home_dir() else {
        return Err("Failed to resolve home directory".to_string());
    };
    Ok(home
        .join(".config")
        .join("opencode")
        .join("scheduler")
        .join("scopes"))
}

fn normalize_path(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(abs) = fs::canonicalize(trimmed) {
        return abs.to_string_lossy().to_string();
    }
    trimmed.to_string()
}

fn load_job_file(path: &Path) -> Option<ScheduledJob> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[derive(Clone)]
struct JobEntry {
    job: ScheduledJob,
    job_file: PathBuf,
}

fn collect_legacy_jobs(jobs_dir: &Path) -> Vec<JobEntry> {
    let mut out = Vec::new();
    if !jobs_dir.exists() {
        return out;
    }
    let Ok(read_dir) = fs::read_dir(jobs_dir) else {
        return out;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        if let Some(job) = load_job_file(&path) {
            out.push(JobEntry {
                job,
                job_file: path,
            });
        }
    }
    out
}

fn collect_scoped_jobs(scopes_dir: &Path) -> Vec<JobEntry> {
    let mut out = Vec::new();
    if !scopes_dir.exists() {
        return out;
    }

    let Ok(scopes) = fs::read_dir(scopes_dir) else {
        return out;
    };

    for scope in scopes.flatten() {
        let scope_path = scope.path();
        if !scope_path.is_dir() {
            continue;
        }
        let scope_id = scope_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if scope_id.is_empty() {
            continue;
        }

        let jobs_dir = scope_path.join("jobs");
        if !jobs_dir.exists() {
            continue;
        }

        let Ok(entries) = fs::read_dir(&jobs_dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(mut job) = load_job_file(&path) else {
                continue;
            };
            if job.scope_id.is_none() {
                job.scope_id = Some(scope_id.clone());
            }
            out.push(JobEntry {
                job,
                job_file: path,
            });
        }
    }

    out
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

fn find_job_entry_by_name(entries: &[JobEntry], name: &str) -> Option<JobEntry> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let slug = slugify(trimmed);
    let lower = trimmed.to_lowercase();
    entries
        .iter()
        .find(|entry| {
            let job = &entry.job;
            job.slug == trimmed
                || job.slug == slug
                || job.slug.ends_with(&format!("-{slug}"))
                || job.name.to_lowercase() == lower
                || job.name.to_lowercase().contains(&lower)
        })
        .cloned()
}

fn collect_jobs_for_scope_root(scope_root: Option<&str>) -> Result<Vec<JobEntry>, String> {
    let legacy_dir = legacy_jobs_dir()?;
    let scopes_dir = scheduler_scopes_dir()?;

    let mut out = Vec::new();
    out.extend(collect_scoped_jobs(&scopes_dir));
    out.extend(collect_legacy_jobs(&legacy_dir));

    let filter_root = scope_root.map(|s| normalize_path(s)).unwrap_or_default();
    if !filter_root.is_empty() {
        out.retain(|entry| {
            entry
                .job
                .workdir
                .as_deref()
                .map(|wd| normalize_path(wd) == filter_root)
                .unwrap_or(false)
        });
    }

    out.sort_by(|a, b| a.job.name.to_lowercase().cmp(&b.job.name.to_lowercase()));
    Ok(out)
}

#[cfg(target_os = "macos")]
fn uninstall_job(slug: &str, scope_id: Option<&str>) -> Result<(), String> {
    let Some(home) = home_dir() else {
        return Err("Failed to resolve home directory".to_string());
    };

    let mut plists = Vec::new();
    if let Some(scope_id) = scope_id {
        let label = format!("com.opencode.job.{scope_id}.{slug}");
        plists.push(
            home.join("Library")
                .join("LaunchAgents")
                .join(format!("{label}.plist")),
        );
    }
    let legacy_label = format!("com.opencode.job.{slug}");
    plists.push(
        home.join("Library")
            .join("LaunchAgents")
            .join(format!("{legacy_label}.plist")),
    );

    for plist in plists {
        if !plist.exists() {
            continue;
        }
        let _ = Command::new("launchctl").arg("unload").arg(&plist).output();
        let _ = fs::remove_file(&plist);
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn uninstall_job(slug: &str, scope_id: Option<&str>) -> Result<(), String> {
    let Some(home) = home_dir() else {
        return Err("Failed to resolve home directory".to_string());
    };

    let base = home.join(".config").join("systemd").join("user");

    let mut timer_units: Vec<String> = Vec::new();
    if let Some(scope_id) = scope_id {
        timer_units.push(format!("opencode-job-{scope_id}-{slug}.timer"));
    }
    timer_units.push(format!("opencode-job-{slug}.timer"));

    for timer_unit in timer_units {
        let _ = Command::new("systemctl")
            .args(["--user", "stop", timer_unit.as_str()])
            .output();
        let _ = Command::new("systemctl")
            .args(["--user", "disable", timer_unit.as_str()])
            .output();
    }

    let mut files: Vec<PathBuf> = Vec::new();
    if let Some(scope_id) = scope_id {
        files.push(base.join(format!("opencode-job-{scope_id}-{slug}.service")));
        files.push(base.join(format!("opencode-job-{scope_id}-{slug}.timer")));
    }
    files.push(base.join(format!("opencode-job-{slug}.service")));
    files.push(base.join(format!("opencode-job-{slug}.timer")));

    for file in files {
        if file.exists() {
            let _ = fs::remove_file(&file);
        }
    }

    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn uninstall_job(_slug: &str, _scope_id: Option<&str>) -> Result<(), String> {
    Err("Scheduler is supported only on macOS and Linux.".to_string())
}

#[tauri::command]
pub fn scheduler_list_jobs(scope_root: Option<String>) -> Result<Vec<ScheduledJob>, String> {
    require_scheduler_support()?;
    let entries = collect_jobs_for_scope_root(scope_root.as_deref())?;
    Ok(entries.into_iter().map(|e| e.job).collect())
}

#[tauri::command]
pub fn scheduler_delete_job(
    name: String,
    scope_root: Option<String>,
) -> Result<ScheduledJob, String> {
    require_scheduler_support()?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name is required".to_string());
    }

    let entries = collect_jobs_for_scope_root(scope_root.as_deref())?;
    let entry = find_job_entry_by_name(&entries, trimmed)
        .ok_or_else(|| format!("Job \"{trimmed}\" not found."))?;

    uninstall_job(&entry.job.slug, entry.job.scope_id.as_deref())?;
    if entry.job_file.exists() {
        fs::remove_file(&entry.job_file).map_err(|e| format!("Failed to remove job file: {e}"))?;
    }

    // Best-effort cleanup of any duplicates.
    if let Ok(legacy_dir) = legacy_jobs_dir() {
        let legacy = legacy_dir.join(format!("{}.json", entry.job.slug));
        if legacy != entry.job_file && legacy.exists() {
            let _ = fs::remove_file(legacy);
        }
    }
    if let (Some(scope_id), Ok(scopes_dir)) =
        (entry.job.scope_id.as_deref(), scheduler_scopes_dir())
    {
        let scoped = scopes_dir
            .join(scope_id)
            .join("jobs")
            .join(format!("{}.json", entry.job.slug));
        if scoped != entry.job_file && scoped.exists() {
            let _ = fs::remove_file(scoped);
        }
    }

    Ok(entry.job)
}
