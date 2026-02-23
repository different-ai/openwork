# Notion Connection: Investigate Double-Restart Issue

**Branch:** `feat/notion-connection-fix`
**Priority:** P2

---

## Problem

From demo: "First time we connect Notion just didn't work. It says no write access... Second time we got CSRF error and third time it worked"

The connection flow requires multiple restart attempts:
1. Connect → "Write request denied"
2. Restart → CSRF error
3. Restart again → Finally works

---

## Hypothesis

The config needs to restart twice:
- Once to detect the MCP is configured
- Second time to actually activate the connection with valid tokens

### Code findings
- MCP auth modal: `packages/app/src/app/components/mcp-auth-modal.tsx:12`
- Auth flow calls OpenCode MCP endpoints: `mcp-auth-modal.tsx:155,180,311`
- Auth modal blocks when reload required: `mcp-auth-modal.tsx:139`
- Notion quick-connect flow: `packages/app/src/app/app.tsx:2177`
  - Writes Notion MCP config: `app.tsx:2222`
  - Marks reload required: `app.tsx:2246`
  - Sets localStorage `openwork.notionStatus`: `app.tsx:2246`
- On startup, `openwork.notionStatus === "connecting"` triggers reload-required: `app.tsx:2817`
- MCP status refresh uses OpenCode `client.mcp.status`: `app.tsx:2294`
- File watcher emits reload-required for config changes: `packages/desktop/src-tauri/src/workspace/watch.rs:99-124`
- UI listener converts event to `markReloadRequired`: `packages/app/src/app/app.tsx:1868`

---

## Investigation Steps

### 1. Trace the OAuth flow

**Files to check:**
- `packages/app/src/app/components/mcp-auth-modal.tsx`
- Server-side MCP handling

Questions:
- When OAuth completes, where is the token saved?
- Does the app know the token is saved?
- Is there a race condition between token save and config reload?

Add checks around `openwork.notionStatus` transitions to confirm if status ever clears after the first reload.

### 2. Check what happens on first restart

Add logging:
```tsx
// In MCP status handling
console.log('[MCP] Notion config:', notionConfig);
console.log('[MCP] Notion status:', notionStatus);
console.log('[MCP] Has token:', !!notionToken);
```

### 3. Check CSRF error source

- Is this from Notion's OAuth?
- Is this from OpenWork server?
- Is there stale state from previous connection attempt?

Check if reload-required is firing twice (explicit `markReloadRequired("mcp")` + file watcher event) right after OAuth.

### 4. Check server restart logic

**Files:**
- `packages/desktop/src-tauri/src/openwork_server/spawn.rs`
- OpenCode server handling

Questions:
- Does restart fully clear MCP state?
- Is there caching that persists across restarts?

---

## Potential Fixes

### Option A: Auto-restart after OAuth

After OAuth token is saved, automatically trigger a server reload:
```tsx
const handleOAuthComplete = async () => {
  await saveToken();
  // Automatically reload to pick up new token
  await reloadWorkspace();
};
```

### Option B: Hot-reload MCP connections

Instead of full restart, implement hot-reload for MCP:
```tsx
const refreshMcpConnection = async (name: string) => {
  // Disconnect existing
  await mcpDisconnect(name);
  // Reconnect with new config
  await mcpConnect(name);
};
```

### Option C: Fix the state mismatch

If the issue is stale state, ensure clean state on connection attempt:
```tsx
const connectNotion = async () => {
  // Clear any cached state
  clearMcpCache("notion");
  // Proceed with fresh connection
  await initiateOAuth("notion");
};
```

**Also consider:** clearing `openwork.notionStatus` after successful engine reload to avoid repeated reload prompts on startup.

---

## Reproduction Steps

1. Fresh install or clear Notion connection
2. Go to MCP settings
3. Click "Connect Notion"
4. Complete OAuth flow
5. Observe error
6. Click Reload
7. Check if working
8. If not, reload again

Track what state changes at each step.

---

## Success Criteria

- Notion connection works on first attempt after OAuth
- No need to restart multiple times
- Clear error messages if something goes wrong
