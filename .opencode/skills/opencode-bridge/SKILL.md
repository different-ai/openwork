---
name: opencode-bridge
description: Bridge between OpenWork UI and OpenCode runtime
---

## Overview

OpenWork communicates with OpenCode via three mechanisms:

1. **CLI invocation**: Spawn `opencode` with prompts and get JSON responses.
2. **Database access**: Read OpenCode's SQLite database for sessions and messages.
3. **MCP bridge**: Real-time bidirectional communication for streaming and permissions.

## CLI Invocation

### Non-interactive mode
```bash
opencode -p "your prompt" -f json -q
```

Returns JSON with the response content.

### Flags
| Flag | Description |
|------|-------------|
| `-p` | Prompt to execute |
| `-f` | Output format (`text`, `json`) |
| `-q` | Quiet mode (no spinner) |
| `-c` | Working directory |
| `-d` | Debug mode |

### Example response
```json
{
  "content": "Here is the result...",
  "session_id": "abc123"
}
```

## Database Access

### Location
```
~/.opencode/opencode.db
```

Or project-local:
```
.opencode/opencode.db
```

### Schema (key tables)

#### sessions
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  title TEXT,
  message_count INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  summary_message_id TEXT,
  cost REAL,
  created_at INTEGER,
  updated_at INTEGER
);
```

#### messages
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  role TEXT,  -- 'user', 'assistant', 'tool'
  parts TEXT, -- JSON array of content parts
  model TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
```

### Querying from Rust (Tauri)
```rust
use tauri_plugin_sql::{Migration, MigrationKind};

#[tauri::command]
async fn list_sessions(db: tauri::State<'_, Database>) -> Result<Vec<Session>, String> {
    let sessions = sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions ORDER BY updated_at DESC"
    )
    .fetch_all(&db.pool)
    .await
    .map_err(|e| e.to_string())?;
    
    Ok(sessions)
}
```

### Querying from SolidJS
```tsx
import Database from "@tauri-apps/plugin-sql";

const db = await Database.load("sqlite:~/.opencode/opencode.db");
const sessions = await db.select<Session[]>(
  "SELECT * FROM sessions ORDER BY updated_at DESC"
);
```

## MCP Bridge (Advanced)

OpenWork can register as an MCP server that OpenCode connects to.

### Configuration (opencode.json)
```json
{
  "mcpServers": {
    "openwork": {
      "type": "stdio",
      "command": "openwork-mcp-bridge"
    }
  }
}
```

### Use cases
- Real-time permission prompts surfaced in OpenWork UI.
- Streaming progress updates.
- Custom tools exposed from OpenWork (e.g., native file picker).

## Message Content Parts

Messages contain a `parts` JSON array with different content types:

### TextContent
```json
{ "type": "text", "text": "Hello world" }
```

### ToolCall
```json
{
  "type": "tool_call",
  "id": "call_123",
  "name": "bash",
  "input": "{\"command\": \"ls\"}"
}
```

### ToolResult
```json
{
  "type": "tool_result",
  "tool_call_id": "call_123",
  "content": "file1.txt\nfile2.txt",
  "is_error": false
}
```

### Finish
```json
{
  "type": "finish",
  "reason": "end_turn",
  "time": 1704067200
}
```

## Common Gotchas

- Database is SQLite; use read-only access to avoid conflicts with running OpenCode.
- Message parts are JSON-encoded strings; parse them in the UI.
- Session IDs are UUIDs; tool call IDs are also UUIDs.
- Cost is in USD; tokens are raw counts.

## First-Time Setup

### Verify OpenCode is installed
```bash
which opencode
opencode --version
```

### Verify database exists
```bash
ls ~/.opencode/opencode.db
```

### Test CLI invocation
```bash
opencode -p "Hello" -f json -q
```
