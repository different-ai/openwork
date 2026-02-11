use serde::Serialize;
use std::path::Path;

const MAX_PREVIEW_SIZE: u64 = 1024 * 1024; // 1MB
const HIDDEN_PREFIXES: &[&str] = &[".", "node_modules", "target", "dist", "build"];

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: Option<u64>,
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileReadResult {
    pub content: String,
    pub size: u64,
    pub language: Option<String>,
}

/// 读取目录内容
#[tauri::command]
pub async fn fs_read_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let path_obj = Path::new(&path);
    
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    if !path_obj.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }
    
    let mut entries = Vec::new();
    
    match std::fs::read_dir(path_obj) {
        Ok(dir_entries) => {
            for entry_result in dir_entries {
                match entry_result {
                    Ok(entry) => {
                        let name = entry.file_name().to_string_lossy().to_string();
                        
                        // 跳过隐藏文件和目录
                        if is_hidden(&name) {
                            continue;
                        }
                        
                        let path_str = entry.path().to_string_lossy().to_string();
                        let metadata = entry.metadata().ok();
                        
                        let entry_type = if entry.path().is_dir() {
                            "directory".to_string()
                        } else {
                            "file".to_string()
                        };
                        
                        let size = metadata.as_ref().map(|m| m.len());
                        let modified = metadata
                            .as_ref()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs());
                        
                        entries.push(FileEntry {
                            name,
                            path: path_str,
                            entry_type,
                            size,
                            modified,
                        });
                    }
                    Err(e) => {
                        eprintln!("Error reading entry: {}", e);
                        continue;
                    }
                }
            }
        }
        Err(e) => {
            return Err(format!("Failed to read directory: {}", e));
        }
    }
    
    // 排序：目录在前，文件在后，按名称排序
    entries.sort_by(|a, b| {
        match (a.entry_type.as_str(), b.entry_type.as_str()) {
            ("directory", "file") => std::cmp::Ordering::Less,
            ("file", "directory") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    
    Ok(entries)
}

/// 读取文件内容
#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<FileReadResult, String> {
    let path_obj = Path::new(&path);
    
    if !path_obj.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    
    if !path_obj.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }
    
    // 检查文件大小
    let metadata = match std::fs::metadata(path_obj) {
        Ok(m) => m,
        Err(e) => return Err(format!("Failed to read file metadata: {}", e)),
    };
    
    let size = metadata.len();
    
    if size > MAX_PREVIEW_SIZE {
        return Err(format!(
            "File too large: {} bytes (max: {} bytes)",
            size, MAX_PREVIEW_SIZE
        ));
    }
    
    // 检测是否为二进制文件
    if is_binary_file(path_obj) {
        return Err("Binary files cannot be previewed".to_string());
    }
    
    // 读取文件内容
    let content = match std::fs::read_to_string(path_obj) {
        Ok(c) => c,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::InvalidData {
                return Err("File appears to be binary or has invalid encoding".to_string());
            }
            return Err(format!("Failed to read file: {}", e));
        }
    };
    
    // 检测语言
    let language = detect_language(path_obj);
    
    Ok(FileReadResult {
        content,
        size,
        language,
    })
}

/// 检查是否为隐藏文件/目录
fn is_hidden(name: &str) -> bool {
    HIDDEN_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

/// 检测是否为二进制文件
fn is_binary_file(path: &Path) -> bool {
    const BINARY_EXTENSIONS: &[&str] = &[
        "exe", "dll", "so", "dylib", "bin",
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "svg", "webp",
        "mp3", "mp4", "wav", "avi", "mov", "mkv",
        "zip", "tar", "gz", "rar", "7z", "bz2", "xz",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "ttf", "otf", "woff", "woff2", "eot",
    ];
    
    if let Some(ext) = path.extension() {
        let ext_str = ext.to_string_lossy().to_lowercase();
        return BINARY_EXTENSIONS.contains(&ext_str.as_str());
    }
    
    false
}

/// 根据文件扩展名检测语言
fn detect_language(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    
    let lang = match ext.as_str() {
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "json" => "json",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "less" => "less",
        "md" | "markdown" => "markdown",
        "py" => "python",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "c" => "c",
        "cpp" | "cc" | "cxx" => "cpp",
        "h" | "hpp" => "cpp",
        "cs" => "csharp",
        "php" => "php",
        "rb" => "ruby",
        "swift" => "swift",
        "kt" => "kotlin",
        "scala" => "scala",
        "r" => "r",
        "sql" => "sql",
        "sh" | "bash" => "shell",
        "ps1" => "powershell",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "dockerfile" => "dockerfile",
        "vue" => "vue",
        "svelte" => "svelte",
        _ => return None,
    };
    
    Some(lang.to_string())
}
