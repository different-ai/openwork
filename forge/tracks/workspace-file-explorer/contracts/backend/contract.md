# Contract: Backend - Workspace File Explorer

## ADDED

### Commands

```rust
// packages/desktop/src-tauri/src/commands/fs.rs

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: String, // "file" | "directory"
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
pub async fn fs_read_dir(path: String) -> Result<Vec<FileEntry>, String>;

/// 读取文件内容
#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<FileReadResult, String>;
```

### Language Detection

```rust
// packages/desktop/src-tauri/src/utils/language.rs

pub fn detect_language(file_path: &str) -> Option<String> {
    // 根据文件扩展名返回 Monaco 语言标识
    // .ts -> "typescript"
    // .tsx -> "typescript"
    // .js -> "javascript"
    // .jsx -> "javascript"
    // .json -> "json"
    // .html -> "html"
    // .css -> "css"
    // .md -> "markdown"
    // ...等等
}
```

### Security & Limits

```rust
// 文件大小限制（预览）
const MAX_PREVIEW_SIZE: u64 = 1024 * 1024; // 1MB

// 二进制文件跳过列表
const BINARY_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib",
    "png", "jpg", "jpeg", "gif", "ico", "svg",
    "mp3", "mp4", "wav", "avi",
    "zip", "tar", "gz", "rar", "7z",
    "pdf", "doc", "docx",
];

// 检查路径是否在工作区内
fn is_path_allowed(path: &str, workspace_root: &str) -> bool;
```

### Error Handling

```rust
pub enum FileSystemError {
    PathNotAllowed,
    FileNotFound,
    FileTooLarge { size: u64, max: u64 },
    BinaryFileNotSupported,
    IoError(String),
}
```

## MODIFIED

### lib.rs

```rust
// 注册新命令
mod commands::fs;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // ... 现有命令
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
        ])
        // ...
}
```

## REMOVED

N/A

---

**Status**: Draft  
**Domain**: Backend  
**Parent**: workspace-file-explorer
