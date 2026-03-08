---
name: past-conversations
description: |
  Find and inspect past conversations from the OpenCode database.

  Triggers when user mentions:
  - "what did we discuss before"
  - "recall our previous conversation"
  - "find our earlier chat about"
  - "what did we talk about"
  - "remember when we discussed"
  - "search past conversations"
---

## When to Use

Use this skill when the user asks to recall a previous conversation or find earlier chats about a specific topic.

Examples:
- "What did we discuss before?"
- "Find our earlier chat about X"
- "Recall the conversation where we talked about..."

## Implementation

All past conversations are stored in the SQLite database at `~/.local/share/opencode/opencode.db`.

### Database Schema

The `part` table contains all message parts:

```sql
CREATE TABLE `part` (
  `id` text PRIMARY KEY,
  `message_id` text NOT NULL,
  `session_id` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL
);
```

### Query Pattern

Use `sqlite3` to search past conversations:

```bash
sqlite3 ~/.local/share/opencode/opencode.db "
SELECT
  s.id as session_id,
  s.title,
  datetime(p.time_created/1000, 'unixepoch') as time,
  json_extract(p.data, '$.text') as text
FROM part p
JOIN message m ON m.id = p.message_id
JOIN session s ON s.id = m.session_id
WHERE json_extract(p.data, '$.type') = 'text'
  AND json_extract(p.data, '$.text') LIKE '%<keyword>%'
ORDER BY p.time_created DESC
LIMIT 20;
"
```

### Output Format

When presenting results:
1. Group by `session_id` (conversation-level grouping)
2. Show session title and timestamp
3. Display relevant text snippets
4. Order by `time_created` (most recent first)

### Notes

- Only search rows where `data` JSON has `type = "text"`
- The `data` field is JSON; use `json_extract()` to access fields
- For large result sets, summarize key points rather than dumping all content
