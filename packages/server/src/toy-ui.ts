export const TOY_UI_CSS = `:root {
  --bg: #0b1020;
  --panel: rgba(255, 255, 255, 0.06);
  --panel-2: rgba(255, 255, 255, 0.04);
  --text: rgba(255, 255, 255, 0.92);
  --muted: rgba(255, 255, 255, 0.68);
  --muted-2: rgba(255, 255, 255, 0.5);
  --border: rgba(255, 255, 255, 0.12);
  --accent: #53b8ff;
  --danger: #ff5b5b;
  --ok: #51d69c;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
}

* { box-sizing: border-box; }

html, body {
  height: 100%;
  margin: 0;
  padding: 0;
  font-family: var(--sans);
  background: radial-gradient(1200px 900px at 20% 10%, rgba(83, 184, 255, 0.14), transparent 60%),
    radial-gradient(900px 700px at 80% 0%, rgba(81, 214, 156, 0.1), transparent 55%),
    linear-gradient(180deg, #080b16, var(--bg));
  color: var(--text);
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.wrap {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 16px 48px;
}

.top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.title h1 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.2px;
}

.title .sub {
  color: var(--muted);
  font-size: 12px;
}

.grid {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  gap: 14px;
}

@media (max-width: 940px) {
  .grid { grid-template-columns: 1fr; }
}

.card {
  background: linear-gradient(180deg, var(--panel), var(--panel-2));
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
}

.card h2 {
  margin: 0;
  padding: 12px 14px;
  font-size: 13px;
  letter-spacing: 0.2px;
  color: rgba(255, 255, 255, 0.88);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.card .body {
  padding: 12px 14px;
}

.row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}

.pill {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--muted);
}

.pill.ok { border-color: rgba(81, 214, 156, 0.45); color: rgba(81, 214, 156, 0.95); }
.pill.bad { border-color: rgba(255, 91, 91, 0.45); color: rgba(255, 91, 91, 0.92); }

.muted { color: var(--muted); }
.mono { font-family: var(--mono); }

.chat {
  height: 56vh;
  min-height: 420px;
  display: flex;
  flex-direction: column;
}

.chatlog {
  flex: 1;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.timeline {
  border-bottom: 1px solid var(--border);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.timeline .list {
  max-height: 160px;
  overflow: auto;
}

.msg {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 10px;
  background: rgba(0, 0, 0, 0.14);
}

.msg .meta {
  font-size: 11px;
  color: var(--muted-2);
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}

.msg .content {
  white-space: pre-wrap;
  line-height: 1.35;
  font-size: 13px;
}

.composer {
  border-top: 1px solid var(--border);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.composer textarea {
  width: 100%;
  resize: vertical;
  min-height: 80px;
  max-height: 220px;
  padding: 10px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.18);
  color: var(--text);
  outline: none;
  font-family: var(--sans);
  font-size: 13px;
}

.composer textarea:focus { border-color: rgba(83, 184, 255, 0.45); }

.input {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 9px 10px;
  background: rgba(0, 0, 0, 0.18);
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.input:focus { border-color: rgba(83, 184, 255, 0.45); }

.btn {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 9px 10px;
  background: rgba(0, 0, 0, 0.18);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.btn:hover { border-color: rgba(83, 184, 255, 0.4); }
.btn.primary { border-color: rgba(83, 184, 255, 0.6); background: rgba(83, 184, 255, 0.12); }
.btn.danger { border-color: rgba(255, 91, 91, 0.6); background: rgba(255, 91, 91, 0.08); }

.kv {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 8px 10px;
  font-size: 12px;
}

.kv .k { color: var(--muted-2); }

.codebox {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.18);
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
  line-height: 1.3;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.item {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.14);
}

.item .row { justify-content: space-between; }

.small { font-size: 11px; color: var(--muted-2); }

.hr { height: 1px; background: var(--border); margin: 10px 0; }

.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tab {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.12);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.tab.active {
  border-color: rgba(83, 184, 255, 0.6);
  background: rgba(83, 184, 255, 0.12);
  color: rgba(255, 255, 255, 0.92);
}

.panel { display: block; margin-top: 10px; }
.panel.hidden { display: none; }
.hidden { display: none !important; }

.inputarea {
  width: 100%;
  resize: vertical;
  min-height: 90px;
  max-height: 260px;
  padding: 10px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.18);
  color: var(--text);
  outline: none;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.35;
}

.inputarea:focus { border-color: rgba(83, 184, 255, 0.45); }
`;

export const TOY_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenWork Toy UI</title>
    <link rel="stylesheet" href="/ui/assets/toy.css" />
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="title">
          <h1>OpenWork Toy UI</h1>
          <div class="sub">Local-first host contract harness (served by openwork-server)</div>
        </div>
        <div class="row">
          <span class="pill" id="pill-conn">disconnected</span>
          <span class="pill" id="pill-scope">scope: unknown</span>
        </div>
      </div>

      <div class="grid">
        <div class="card chat">
          <h2>
            <span>Session</span>
            <span class="small mono" id="session-id">session: -</span>
          </h2>
          <div class="timeline">
            <div class="row">
              <span class="pill" id="pill-run">idle</span>
              <span class="small" id="timeline-hint">Checkpoints stream from SSE events.</span>
            </div>
            <div class="list" id="timeline"></div>
          </div>
          <div class="chatlog" id="chatlog"></div>
          <div class="composer">
            <div class="row">
              <button class="btn" id="btn-new">New session</button>
              <button class="btn" id="btn-refresh">Refresh messages</button>
              <button class="btn" id="btn-delete-session">Delete session</button>
              <span class="small" id="hint">Tip: open this page as /w/&lt;id&gt;/ui#token=&lt;token&gt;</span>
            </div>
            <textarea id="prompt" placeholder="Write a prompt..." spellcheck="false"></textarea>
            <div class="row">
              <button class="btn primary" id="btn-send">Send prompt</button>
              <button class="btn" id="btn-skill">Turn into skill</button>
              <button class="btn" id="btn-events">Connect SSE</button>
              <button class="btn" id="btn-events-stop">Stop SSE</button>
              <span class="small" id="status"></span>
            </div>
          </div>
        </div>

        <div class="card">
          <h2><span>Host</span><span class="small mono" id="host-id">-</span></h2>
          <div class="body">
            <div class="kv">
              <div class="k">workspace</div>
              <div class="mono" id="workspace-id">-</div>
              <div class="k">workspace url</div>
              <div><a class="mono" id="workspace-url" href="#" target="_blank" rel="noreferrer">-</a></div>
              <div class="k">server</div>
              <div class="mono" id="server-version">-</div>
              <div class="k">sandbox</div>
              <div class="mono" id="sandbox">-</div>
              <div class="k">file injection</div>
              <div class="mono" id="file-injection">-</div>
            </div>

            <div class="hr"></div>

            <div class="tabs" id="tabs">
              <button class="tab active" data-tab="share">Share</button>
              <button class="tab" data-tab="automations">Automations</button>
              <button class="tab" data-tab="skills">Skills</button>
              <button class="tab" data-tab="plugins">Plugins</button>
              <button class="tab" data-tab="apps">Apps</button>
              <button class="tab" data-tab="config">Config</button>
            </div>

            <div class="panel" data-panel="share">
              <div class="row">
                <select class="input" id="share-scope">
                  <option value="collaborator">collaborator</option>
                  <option value="viewer">viewer</option>
                </select>
                <input class="input" id="share-label" type="text" placeholder="label (optional)" />
                <button class="btn" id="btn-mint">Mint token</button>
                <button class="btn" id="btn-deploy">Deploy (Beta)</button>
              </div>
              <div class="small">Minting tokens requires an owner token (or host access).</div>

              <div class="hr"></div>

              <div class="row">
                <button class="btn" id="btn-share">Connect artifact (current token)</button>
                <button class="btn" id="btn-copy">Copy JSON</button>
                <button class="btn" id="btn-tokens">List tokens</button>
              </div>
              <div class="codebox" id="connect"></div>
              <div class="list" id="tokens"></div>

              <div class="hr"></div>

              <div class="row">
                <button class="btn" id="btn-export">Export workspace</button>
              </div>
              <div class="codebox" id="export"></div>

              <div class="hr"></div>

              <div class="row">
                <button class="btn" id="btn-import">Import workspace</button>
                <span class="small">(pastes JSON below)</span>
              </div>
              <textarea class="inputarea" id="import" placeholder="Paste export JSON..." spellcheck="false"></textarea>

              <div class="hr"></div>

              <div class="row">
                <button class="btn danger" id="btn-delete-workspace">Delete workspace</button>
                <span class="small">Removes from host config. Requires owner/host token.</span>
              </div>
            </div>

            <div class="panel hidden" data-panel="automations">
              <div class="row">
                <button class="btn" id="btn-auto-refresh">Refresh</button>
                <span class="small">Apply schedule on host via <span class="mono">openwork-agent-lab scheduler sync</span>.</span>
              </div>
              <div class="list" id="automations"></div>

              <div class="codebox" id="auto-log"></div>

              <div class="hr"></div>

              <div class="small">Create automation</div>
              <div class="row">
                <input class="input" id="auto-name" type="text" placeholder="name" />
                <select class="input" id="auto-kind">
                  <option value="interval">interval</option>
                  <option value="daily">daily</option>
                  <option value="weekly">weekly</option>
                </select>
              </div>
              <div class="row" id="auto-interval-row">
                <input class="input" id="auto-interval" type="number" min="60" step="60" placeholder="seconds" />
                <span class="small">StartInterval</span>
              </div>
              <div class="row hidden" id="auto-daily-row">
                <input class="input" id="auto-hour" type="number" min="0" max="23" placeholder="hour" />
                <input class="input" id="auto-minute" type="number" min="0" max="59" placeholder="minute" />
                <span class="small">local time</span>
              </div>
              <div class="row hidden" id="auto-weekly-row">
                <select class="input" id="auto-weekday">
                  <option value="1">Sun</option>
                  <option value="2">Mon</option>
                  <option value="3">Tue</option>
                  <option value="4">Wed</option>
                  <option value="5">Thu</option>
                  <option value="6">Fri</option>
                  <option value="7">Sat</option>
                </select>
                <input class="input" id="auto-weekly-hour" type="number" min="0" max="23" placeholder="hour" />
                <input class="input" id="auto-weekly-minute" type="number" min="0" max="59" placeholder="minute" />
              </div>
              <textarea class="inputarea" id="auto-prompt" placeholder="Prompt..." spellcheck="false"></textarea>
              <div class="row">
                <button class="btn primary" id="btn-auto-save">Save automation</button>
              </div>
            </div>

            <div class="panel hidden" data-panel="skills">
              <div class="row">
                <button class="btn" id="btn-skills-refresh">Refresh</button>
                <span class="small">Managed in <span class="mono">.opencode/skills/</span></span>
              </div>
              <div class="list" id="skills"></div>
            </div>

            <div class="panel hidden" data-panel="plugins">
              <div class="row">
                <input class="input" id="plugin-spec" type="text" placeholder="plugin spec" />
                <button class="btn" id="btn-plugin-add">Add</button>
                <button class="btn" id="btn-plugins-refresh">Refresh</button>
              </div>
              <div class="list" id="plugins"></div>
            </div>

            <div class="panel hidden" data-panel="apps">
              <div class="row">
                <button class="btn" id="btn-mcp-refresh">Refresh</button>
                <span class="small">MCP servers from <span class="mono">opencode.json</span></span>
              </div>
              <div class="list" id="mcp"></div>
            </div>

            <div class="panel hidden" data-panel="config">
              <div class="row">
                <input id="file" type="file" />
                <button class="btn" id="btn-upload">Upload to inbox</button>
              </div>
              <div class="small">Uploads go to <span class="mono">.opencode/openwork/inbox/</span> inside the workspace.</div>

              <div class="hr"></div>

              <div class="row">
                <button class="btn" id="btn-artifacts">List artifacts</button>
                <span class="small">Downloads read from <span class="mono">.opencode/openwork/outbox/</span>.</span>
              </div>
              <div class="list" id="artifacts"></div>

              <div class="hr"></div>

              <div class="row">
                <button class="btn" id="btn-approvals">Refresh approvals</button>
                <span class="small">(Owner or host token required)</span>
              </div>
              <div class="list" id="approvals"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script type="module" src="/ui/assets/toy.js"></script>
  </body>
</html>
`;

export const TOY_UI_JS = String.raw`const qs = (sel) => document.querySelector(sel);

const pillConn = qs("#pill-conn");
const pillScope = qs("#pill-scope");
const chatlog = qs("#chatlog");
const promptEl = qs("#prompt");
const statusEl = qs("#status");
const sessionIdEl = qs("#session-id");
const workspaceIdEl = qs("#workspace-id");
const serverVersionEl = qs("#server-version");
const sandboxEl = qs("#sandbox");
const fileInjectionEl = qs("#file-injection");
const artifactsEl = qs("#artifacts");
const approvalsEl = qs("#approvals");
const connectEl = qs("#connect");
const tokensEl = qs("#tokens");
const exportEl = qs("#export");
const importEl = qs("#import");
const automationsEl = qs("#automations");
const skillsEl = qs("#skills");
const pluginsEl = qs("#plugins");
const pluginSpecEl = qs("#plugin-spec");
const mcpEl = qs("#mcp");
const hostIdEl = qs("#host-id");
const pillRun = qs("#pill-run");
const timelineEl = qs("#timeline");
const workspaceUrlEl = qs("#workspace-url");
const shareScopeEl = qs("#share-scope");
const shareLabelEl = qs("#share-label");
const tabsEl = qs("#tabs");

const autoNameEl = qs("#auto-name");
const autoKindEl = qs("#auto-kind");
const autoIntervalEl = qs("#auto-interval");
const autoHourEl = qs("#auto-hour");
const autoMinuteEl = qs("#auto-minute");
const autoWeekdayEl = qs("#auto-weekday");
const autoWeeklyHourEl = qs("#auto-weekly-hour");
const autoWeeklyMinuteEl = qs("#auto-weekly-minute");
const autoPromptEl = qs("#auto-prompt");
const autoIntervalRow = qs("#auto-interval-row");
const autoDailyRow = qs("#auto-daily-row");
const autoWeeklyRow = qs("#auto-weekly-row");
const autoLogEl = qs("#auto-log");

const STORAGE_TOKEN = "openwork.toy.token";
const STORAGE_SESSION_PREFIX = "openwork.toy.session.";

function setPill(el, label, kind) {
  el.textContent = label;
  el.classList.remove("ok", "bad");
  if (kind) el.classList.add(kind);
}

function setRun(label, kind) {
  if (!pillRun) return;
  setPill(pillRun, label, kind);
}

function clearTimeline() {
  if (!timelineEl) return;
  timelineEl.innerHTML = "";
}

function summarizeEvent(payload) {
  if (!payload || typeof payload !== "object") return "";
  const keys = ["name", "tool", "action", "summary", "status", "message"];
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function addCheckpoint(label, detail) {
  if (!timelineEl) return;

  const row = document.createElement("div");
  row.className = "item";

  const top = document.createElement("div");
  top.className = "row";

  const left = document.createElement("div");
  const name = document.createElement("div");
  name.className = "mono";
  name.textContent = label;

  const meta = document.createElement("div");
  meta.className = "small";
  meta.textContent = new Date().toLocaleTimeString();

  left.appendChild(name);
  left.appendChild(meta);
  top.appendChild(left);
  row.appendChild(top);

  if (detail) {
    const d = document.createElement("div");
    d.className = "small";
    d.textContent = detail;
    row.appendChild(d);
  }

  timelineEl.appendChild(row);
  timelineEl.scrollTop = timelineEl.scrollHeight;

  while (timelineEl.children.length > 80) {
    timelineEl.removeChild(timelineEl.firstChild);
  }
}

let activeTab = "share";

function setTab(tab) {
  activeTab = tab;
  if (tabsEl) {
    const buttons = tabsEl.querySelectorAll(".tab");
    buttons.forEach((btn) => {
      const t = btn.getAttribute("data-tab") || "";
      btn.classList.toggle("active", t === tab);
    });
  }

  const panels = document.querySelectorAll(".panel");
  panels.forEach((panel) => {
    const t = panel.getAttribute("data-panel") || "";
    panel.classList.toggle("hidden", t !== tab);
  });
}

function getTokenFromHash() {
  const raw = (location.hash || "").startsWith("#") ? (location.hash || "").slice(1) : (location.hash || "");
  if (!raw) return "";
  const params = new URLSearchParams(raw);
  return (params.get("token") || "").trim();
}

function stripHashToken() {
  const raw = (location.hash || "").startsWith("#") ? (location.hash || "").slice(1) : (location.hash || "");
  if (!raw) return;
  const params = new URLSearchParams(raw);
  if (!params.has("token")) return;
  params.delete("token");
  const next = params.toString();
  const url = location.pathname + location.search + (next ? "#" + next : "");
  history.replaceState(null, "", url);
}

function readToken() {
  const fromHash = getTokenFromHash();
  if (fromHash) {
    try { localStorage.setItem(STORAGE_TOKEN, fromHash); } catch {}
    stripHashToken();
    return fromHash;
  }
  try {
    return (localStorage.getItem(STORAGE_TOKEN) || "").trim();
  } catch {
    return "";
  }
}

function parseWorkspaceIdFromPath() {
  const parts = location.pathname.split("/").filter(Boolean);
  const wIndex = parts.indexOf("w");
  if (wIndex !== -1 && parts[wIndex + 1]) return decodeURIComponent(parts[wIndex + 1]);
  return "";
}

async function apiFetch(path, options) {
  const token = readToken();
  const opts = options || {};
  const headers = new Headers(opts.headers || {});
  if (!headers.has("Content-Type") && opts.body && !(opts.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", "Bearer " + token);
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json && json.message ? json.message : (text || res.statusText);
    const code = json && json.code ? json.code : "request_failed";
    const err = new Error(code + ": " + msg);
    err.status = res.status;
    err.code = code;
    err.details = json && json.details ? json.details : undefined;
    throw err;
  }
  return json;
}

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.style.color = kind === "bad" ? "var(--danger)" : kind === "ok" ? "var(--ok)" : "var(--muted)";
}

function appendMsg(role, text) {
  const el = document.createElement("div");
  el.className = "msg";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = role;
  const content = document.createElement("div");
  content.className = "content";
  content.textContent = text;
  el.appendChild(meta);
  el.appendChild(content);
  chatlog.appendChild(el);
  chatlog.scrollTop = chatlog.scrollHeight;
}

function renderMessages(items) {
  chatlog.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    appendMsg("system", "No messages yet.");
    return;
  }
  for (const msg of items) {
    const info = msg && msg.info ? msg.info : null;
    const parts = Array.isArray(msg && msg.parts) ? msg.parts : [];
    const role = info && info.role ? info.role : "message";
    const textParts = parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text);
    const body = textParts.length ? textParts.join("\n") : JSON.stringify(parts, null, 2);
    appendMsg(role, body);
  }
}

function sessionKey(workspaceId) {
  return STORAGE_SESSION_PREFIX + workspaceId;
}

function readSessionId(workspaceId) {
  try { return (localStorage.getItem(sessionKey(workspaceId)) || "").trim(); } catch { return ""; }
}

function writeSessionId(workspaceId, sessionId) {
  try { localStorage.setItem(sessionKey(workspaceId), sessionId); } catch {}
}

async function resolveDefaultModel(workspaceId) {
  try {
    const providers = await apiFetch("/w/" + encodeURIComponent(workspaceId) + "/opencode/config/providers");
    const def = providers && providers.default ? providers.default : null;
    if (def && typeof def === "object") {
      const entries = Object.entries(def);
      if (entries.length) {
        const providerID = entries[0][0];
        const modelID = entries[0][1];
        if (providerID && modelID) return { providerID, modelID };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function ensureSession(workspaceId) {
  const existing = readSessionId(workspaceId);
  if (existing) return existing;
  const created = await apiFetch("/w/" + encodeURIComponent(workspaceId) + "/opencode/session", {
    method: "POST",
    body: JSON.stringify({ title: "OpenWork Toy UI" }),
  });
  const id = created && created.id ? String(created.id) : "";
  if (!id) throw new Error("session_create_failed");
  writeSessionId(workspaceId, id);
  return id;
}

async function refreshHost(workspaceId) {
  const token = readToken();
  if (!token) {
    setPill(pillConn, "token missing", "bad");
    setStatus("Add #token=... to the URL fragment", "bad");
    return;
  }
  try {
    const status = await apiFetch("/status");
    const caps = await apiFetch("/capabilities");
    hostIdEl.textContent = location.origin;
    serverVersionEl.textContent = caps && caps.serverVersion ? caps.serverVersion : (status && status.version ? status.version : "-");
    const sandbox = caps && caps.sandbox ? caps.sandbox : null;
    sandboxEl.textContent = sandbox ? (sandbox.backend + " (" + (sandbox.enabled ? "on" : "off") + ")") : "-";
    const files = caps && caps.toolProviders && caps.toolProviders.files ? caps.toolProviders.files : null;
    fileInjectionEl.textContent = files ? ((files.injection ? "upload" : "no upload") + " / " + (files.outbox ? "download" : "no download")) : "-";
    workspaceIdEl.textContent = workspaceId || "-";
    setPill(pillConn, "connected", "ok");
    setStatus("Connected", "ok");

    try {
      const me = await apiFetch("/whoami");
      const scope = me && me.actor && me.actor.scope ? me.actor.scope : "unknown";
      pillScope.textContent = "scope: " + scope;
    } catch {
      pillScope.textContent = "scope: unknown";
    }
  } catch (e) {
    setPill(pillConn, "disconnected", "bad");
    setStatus(e && e.message ? e.message : "Disconnected", "bad");
  }
}

async function refreshMessages(workspaceId) {
  const sessionId = readSessionId(workspaceId);
  sessionIdEl.textContent = sessionId ? ("session: " + sessionId) : "session: -";
  if (!sessionId) {
    renderMessages([]);
    return;
  }
  const url = "/w/" + encodeURIComponent(workspaceId) + "/opencode/session/" + encodeURIComponent(sessionId) + "/message?limit=50";
  const msgs = await apiFetch(url);
  renderMessages(msgs);
}

async function listArtifacts(workspaceId) {
  const data = await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/artifacts");
  const items = Array.isArray(data && data.items) ? data.items : [];
  artifactsEl.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.textContent = "No artifacts found.";
    artifactsEl.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "item";

    const top = document.createElement("div");
    top.className = "row";

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "mono";
    name.textContent = item.path;
    const meta = document.createElement("div");
    meta.className = "small";
    meta.textContent = String(item.size) + " bytes";
    left.appendChild(name);
    left.appendChild(meta);

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Download";
    btn.onclick = async () => {
      try {
        const res = await fetch(
          "/workspace/" + encodeURIComponent(workspaceId) + "/artifacts/" + encodeURIComponent(item.id),
          { headers: { Authorization: "Bearer " + readToken() } },
        );
        if (!res.ok) throw new Error("download_failed: " + res.status);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const parts = String(item.path || "artifact").split("/");
        a.download = parts.length ? parts[parts.length - 1] : "artifact";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setStatus(e && e.message ? e.message : "Download failed", "bad");
      }
    };

    top.appendChild(left);
    top.appendChild(btn);
    row.appendChild(top);
    artifactsEl.appendChild(row);
  }
}

async function refreshApprovals() {
  approvalsEl.innerHTML = "";
  try {
    const data = await apiFetch("/approvals");
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.textContent = "No pending approvals.";
      approvalsEl.appendChild(empty);
      return;
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";

      const top = document.createElement("div");
      top.className = "row";

      const left = document.createElement("div");
      const action = document.createElement("div");
      action.className = "mono";
      action.textContent = item.action;
      const summary = document.createElement("div");
      summary.className = "small";
      summary.textContent = item.summary;
      left.appendChild(action);
      left.appendChild(summary);

      const buttons = document.createElement("div");
      buttons.className = "row";

      const allow = document.createElement("button");
      allow.className = "btn primary";
      allow.textContent = "Allow";

      const deny = document.createElement("button");
      deny.className = "btn danger";
      deny.textContent = "Deny";

      allow.onclick = async () => {
        await apiFetch("/approvals/" + encodeURIComponent(item.id), {
          method: "POST",
          body: JSON.stringify({ reply: "allow" }),
        });
        await refreshApprovals();
      };

      deny.onclick = async () => {
        await apiFetch("/approvals/" + encodeURIComponent(item.id), {
          method: "POST",
          body: JSON.stringify({ reply: "deny" }),
        });
        await refreshApprovals();
      };

      buttons.appendChild(allow);
      buttons.appendChild(deny);

      top.appendChild(left);
      top.appendChild(buttons);
      row.appendChild(top);
      approvalsEl.appendChild(row);
    }
  } catch (e) {
    const warn = document.createElement("div");
    warn.className = "item";
    warn.textContent = e && e.message ? e.message : "Approvals unavailable";
    approvalsEl.appendChild(warn);
  }
}

let eventsAbort = null;

async function connectSse(workspaceId) {
  if (eventsAbort) return;
  const controller = new AbortController();
  eventsAbort = controller;
  setStatus("Connecting SSE...", "");
  addCheckpoint("sse.connecting");

  const url = "/w/" + encodeURIComponent(workspaceId) + "/opencode/event";
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + readToken() },
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    eventsAbort = null;
    throw new Error("sse_failed: " + res.status);
  }

  setStatus("SSE connected", "ok");
  addCheckpoint("sse.connected");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  const pump = async () => {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += next.value;
      buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith("data:")) {
            const rest = line.slice(5);
            dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
          }
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join("\n");
        try {
          const event = JSON.parse(raw);
          const payload = event && event.payload ? event.payload : event;
          const type = payload && payload.type ? String(payload.type) : (event && event.type ? String(event.type) : "event");
          addCheckpoint(type, summarizeEvent(payload));
          if (type.endsWith(".completed") || type.endsWith(".finished") || type.endsWith(".stopped")) {
            setRun("idle");
          }
          if (payload && payload.type === "message.part.updated") {
            void refreshMessages(workspaceId);
          }
        } catch {
          // ignore
        }
      }
    }
  };

  pump()
    .catch(() => undefined)
    .finally(() => {
      eventsAbort = null;
      try { reader.releaseLock(); } catch {}
      setStatus("SSE disconnected", "");
      addCheckpoint("sse.disconnected");
      setRun("idle");
    });
}

function stopSse() {
  if (!eventsAbort) return;
  eventsAbort.abort();
  eventsAbort = null;
}

function renderConnectArtifact(workspaceId, token, scope) {
  const hostUrl = location.origin;
  const workspaceUrl = hostUrl + "/w/" + encodeURIComponent(workspaceId);
  const payload = {
    kind: "openwork.connect.v1",
    hostUrl: hostUrl,
    workspaceId: workspaceId,
    workspaceUrl: workspaceUrl,
    token: token,
    tokenScope: scope,
    createdAt: Date.now(),
  };
  connectEl.textContent = JSON.stringify(payload, null, 2);
}

async function showConnectArtifact(workspaceId) {
  const token = readToken();
  let scope = "collaborator";
  try {
    const me = await apiFetch("/whoami");
    const s = me && me.actor && me.actor.scope ? me.actor.scope : "";
    if (s) scope = s;
  } catch {
    // ignore
  }
  renderConnectArtifact(workspaceId, token, scope);
}

async function mintShareToken(workspaceId) {
  const scope = shareScopeEl && shareScopeEl.value ? String(shareScopeEl.value) : "collaborator";
  const label = shareLabelEl && shareLabelEl.value ? String(shareLabelEl.value).trim() : "";
  const issued = await apiFetch("/tokens", {
    method: "POST",
    body: JSON.stringify({ scope, label: label || undefined }),
  });
  const token = issued && issued.token ? String(issued.token) : "";
  const tokenScope = issued && issued.scope ? String(issued.scope) : scope;
  if (!token) throw new Error("token_missing");
  renderConnectArtifact(workspaceId, token, tokenScope);
  setStatus("Token minted: " + tokenScope, "ok");
}

async function refreshTokens() {
  if (!tokensEl) return;
  tokensEl.innerHTML = "";
  try {
    const data = await apiFetch("/tokens");
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.textContent = "No tokens.";
      tokensEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      const top = document.createElement("div");
      top.className = "row";

      const left = document.createElement("div");
      const title = document.createElement("div");
      title.className = "mono";
      title.textContent = (item.scope ? String(item.scope) : "token") + "  " + (item.id ? String(item.id) : "");
      const meta = document.createElement("div");
      meta.className = "small";
      meta.textContent = item.label ? String(item.label) : "";
      left.appendChild(title);
      if (meta.textContent) left.appendChild(meta);

      const revoke = document.createElement("button");
      revoke.className = "btn danger";
      revoke.textContent = "Revoke";
      revoke.onclick = async () => {
        try {
          await apiFetch("/tokens/" + encodeURIComponent(String(item.id || "")), { method: "DELETE" });
          await refreshTokens();
        } catch (e) {
          setStatus(e && e.message ? e.message : "Revoke failed", "bad");
        }
      };

      top.appendChild(left);
      top.appendChild(revoke);
      row.appendChild(top);
      tokensEl.appendChild(row);
    }
  } catch (e) {
    const warn = document.createElement("div");
    warn.className = "item";
    warn.textContent = e && e.message ? e.message : "Tokens unavailable";
    tokensEl.appendChild(warn);
  }
}

async function exportWorkspace(workspaceId) {
  if (!exportEl) return;
  exportEl.textContent = "";
  const data = await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/export");
  exportEl.textContent = JSON.stringify(data, null, 2);
}

async function importWorkspace(workspaceId) {
  if (!importEl) return;
  const raw = (importEl.value || "").trim();
  if (!raw) throw new Error("import_json_missing");
  let payload = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (!payload) throw new Error("import_json_invalid");
  await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function scheduleSummary(schedule) {
  if (!schedule || typeof schedule !== "object") return "";
  const kind = String(schedule.kind || "");
  const pad2 = (n) => String(n).padStart(2, "0");
  if (kind === "interval") {
    const seconds = Number(schedule.seconds || 0);
    return seconds ? ("every " + seconds + "s") : "interval";
  }
  if (kind === "daily") {
    return "daily " + pad2(schedule.hour) + ":" + pad2(schedule.minute);
  }
  if (kind === "weekly") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekday = Number(schedule.weekday || 1);
    const day = days[Math.max(1, Math.min(7, weekday)) - 1] || "?";
    return "weekly " + day + " " + pad2(schedule.hour) + ":" + pad2(schedule.minute);
  }
  return kind || "schedule";
}

let automationsCache = [];

async function refreshAutomations(workspaceId) {
  if (!automationsEl) return;
  if (autoLogEl) autoLogEl.textContent = "";
  automationsEl.innerHTML = "";
  try {
    const data = await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/agentlab/automations");
    const items = Array.isArray(data && data.items) ? data.items : [];
    automationsCache = items;
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.textContent = "No automations yet.";
      automationsEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";

      const top = document.createElement("div");
      top.className = "row";

      const left = document.createElement("div");
      const name = document.createElement("div");
      name.className = "mono";
      name.textContent = item.name + "  (" + item.id + ")";
      const meta = document.createElement("div");
      meta.className = "small";
      meta.textContent = (item.enabled ? "enabled" : "disabled") + " - " + scheduleSummary(item.schedule);
      left.appendChild(name);
      left.appendChild(meta);

      const buttons = document.createElement("div");
      buttons.className = "row";

      const runBtn = document.createElement("button");
      runBtn.className = "btn";
      runBtn.textContent = "Run";
      runBtn.onclick = async () => {
        try {
          const res = await apiFetch(
            "/workspace/" + encodeURIComponent(workspaceId) + "/agentlab/automations/" + encodeURIComponent(item.id) + "/run",
            { method: "POST", body: JSON.stringify({}) },
          );
          const sessionId = res && res.sessionId ? String(res.sessionId) : "";
          if (sessionId) {
            writeSessionId(workspaceId, sessionId);
            sessionIdEl.textContent = "session: " + sessionId;
            await refreshMessages(workspaceId).catch(() => undefined);
          }
          setStatus("Automation started", "ok");
        } catch (e) {
          setStatus(e && e.message ? e.message : "Automation failed", "bad");
        }
      };

      const logBtn = document.createElement("button");
      logBtn.className = "btn";
      logBtn.textContent = "Logs";
      logBtn.onclick = async () => {
        if (!autoLogEl) return;
        autoLogEl.textContent = "";
        try {
          const data = await apiFetch(
            "/workspace/" + encodeURIComponent(workspaceId) + "/agentlab/automations/logs/" + encodeURIComponent(item.id),
          );
          autoLogEl.textContent = data && data.content ? String(data.content) : "";
        } catch (e) {
          autoLogEl.textContent = e && e.message ? e.message : "Log not available";
        }
      };

      const delBtn = document.createElement("button");
      delBtn.className = "btn danger";
      delBtn.textContent = "Delete";
      delBtn.onclick = async () => {
        try {
          await apiFetch(
            "/workspace/" + encodeURIComponent(workspaceId) + "/agentlab/automations/" + encodeURIComponent(item.id),
            { method: "DELETE" },
          );
          await refreshAutomations(workspaceId);
        } catch (e) {
          setStatus(e && e.message ? e.message : "Delete failed", "bad");
        }
      };

      buttons.appendChild(runBtn);
      buttons.appendChild(logBtn);
      buttons.appendChild(delBtn);

      top.appendChild(left);
      top.appendChild(buttons);
      row.appendChild(top);
      automationsEl.appendChild(row);
    }
  } catch (e) {
    const warn = document.createElement("div");
    warn.className = "item";
    warn.textContent = e && e.message ? e.message : "Automations unavailable";
    automationsEl.appendChild(warn);
  }
}

function updateAutomationScheduleUI() {
  const kind = autoKindEl && autoKindEl.value ? String(autoKindEl.value) : "interval";
  if (autoIntervalRow) autoIntervalRow.classList.toggle("hidden", kind !== "interval");
  if (autoDailyRow) autoDailyRow.classList.toggle("hidden", kind !== "daily");
  if (autoWeeklyRow) autoWeeklyRow.classList.toggle("hidden", kind !== "weekly");
}

async function saveAutomation(workspaceId) {
  const name = autoNameEl && autoNameEl.value ? String(autoNameEl.value).trim() : "";
  const prompt = autoPromptEl && autoPromptEl.value ? String(autoPromptEl.value).trim() : "";
  if (!name) throw new Error("name_required");
  if (!prompt) throw new Error("prompt_required");
  const kind = autoKindEl && autoKindEl.value ? String(autoKindEl.value) : "interval";
  let schedule = null;
  if (kind === "interval") {
    schedule = { kind: "interval", seconds: Number(autoIntervalEl && autoIntervalEl.value ? autoIntervalEl.value : 3600) };
  } else if (kind === "daily") {
    schedule = {
      kind: "daily",
      hour: Number(autoHourEl && autoHourEl.value ? autoHourEl.value : 9),
      minute: Number(autoMinuteEl && autoMinuteEl.value ? autoMinuteEl.value : 0),
    };
  } else {
    schedule = {
      kind: "weekly",
      weekday: Number(autoWeekdayEl && autoWeekdayEl.value ? autoWeekdayEl.value : 2),
      hour: Number(autoWeeklyHourEl && autoWeeklyHourEl.value ? autoWeeklyHourEl.value : 9),
      minute: Number(autoWeeklyMinuteEl && autoWeeklyMinuteEl.value ? autoWeeklyMinuteEl.value : 0),
    };
  }
  await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/agentlab/automations", {
    method: "POST",
    body: JSON.stringify({ name, prompt, enabled: true, schedule }),
  });
}

async function refreshSkills(workspaceId) {
  if (!skillsEl) return;
  skillsEl.innerHTML = "";
  try {
    const data = await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/skills");
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.textContent = "No skills found.";
      skillsEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      const top = document.createElement("div");
      top.className = "row";
      const left = document.createElement("div");
      const name = document.createElement("div");
      name.className = "mono";
      name.textContent = item.name;
      const meta = document.createElement("div");
      meta.className = "small";
      meta.textContent = item.description || (item.scope ? String(item.scope) : "");
      left.appendChild(name);
      if (meta.textContent) left.appendChild(meta);

      const delBtn = document.createElement("button");
      delBtn.className = "btn danger";
      delBtn.textContent = "Delete";
      delBtn.disabled = item.scope !== "project";
      delBtn.onclick = async () => {
        try {
          await apiFetch(
            "/workspace/" + encodeURIComponent(workspaceId) + "/skills/" + encodeURIComponent(item.name),
            { method: "DELETE" },
          );
          await refreshSkills(workspaceId);
        } catch (e) {
          setStatus(e && e.message ? e.message : "Delete failed", "bad");
        }
      };

      top.appendChild(left);
      top.appendChild(delBtn);
      row.appendChild(top);
      skillsEl.appendChild(row);
    }
  } catch (e) {
    const warn = document.createElement("div");
    warn.className = "item";
    warn.textContent = e && e.message ? e.message : "Skills unavailable";
    skillsEl.appendChild(warn);
  }
}

async function refreshPlugins(workspaceId) {
  if (!pluginsEl) return;
  pluginsEl.innerHTML = "";
  try {
    const data = await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/plugins");
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.textContent = "No plugins.";
      pluginsEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      const top = document.createElement("div");
      top.className = "row";
      const left = document.createElement("div");
      const spec = document.createElement("div");
      spec.className = "mono";
      spec.textContent = item.spec;
      const meta = document.createElement("div");
      meta.className = "small";
      meta.textContent = (item.source ? String(item.source) : "") + (item.scope ? " / " + String(item.scope) : "");
      left.appendChild(spec);
      if (meta.textContent) left.appendChild(meta);

      const delBtn = document.createElement("button");
      delBtn.className = "btn danger";
      delBtn.textContent = "Remove";
      delBtn.disabled = item.source !== "config";
      delBtn.onclick = async () => {
        try {
          await apiFetch(
            "/workspace/" + encodeURIComponent(workspaceId) + "/plugins/" + encodeURIComponent(item.spec),
            { method: "DELETE" },
          );
          await refreshPlugins(workspaceId);
        } catch (e) {
          setStatus(e && e.message ? e.message : "Remove failed", "bad");
        }
      };

      top.appendChild(left);
      top.appendChild(delBtn);
      row.appendChild(top);
      pluginsEl.appendChild(row);
    }
  } catch (e) {
    const warn = document.createElement("div");
    warn.className = "item";
    warn.textContent = e && e.message ? e.message : "Plugins unavailable";
    pluginsEl.appendChild(warn);
  }
}

async function refreshMcp(workspaceId) {
  if (!mcpEl) return;
  mcpEl.innerHTML = "";
  try {
    const data = await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/mcp");
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.textContent = "No MCP servers.";
      mcpEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      const name = document.createElement("div");
      name.className = "mono";
      name.textContent = item.name;
      const meta = document.createElement("div");
      meta.className = "small";
      meta.textContent = item.disabledByTools ? "disabled" : "enabled";
      row.appendChild(name);
      row.appendChild(meta);
      mcpEl.appendChild(row);
    }
  } catch (e) {
    const warn = document.createElement("div");
    warn.className = "item";
    warn.textContent = e && e.message ? e.message : "MCP unavailable";
    mcpEl.appendChild(warn);
  }
}

async function copyConnectArtifact() {
  const text = connectEl.textContent || "";
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied", "ok");
  } catch {
    setStatus("Clipboard unavailable", "bad");
  }
}

async function main() {
  const workspaceId = parseWorkspaceIdFromPath();
  if (!workspaceId) {
    const token = readToken();
    if (!token) {
      appendMsg("system", "Open this as /ui#token=<token> or /w/<workspaceId>/ui#token=<token>");
      return;
    }
    try {
      const workspaces = await apiFetch("/workspaces");
      const active = (workspaces && workspaces.activeId) || (workspaces && workspaces.items && workspaces.items[0] && workspaces.items[0].id) || "";
      if (active) {
        location.href = "/w/" + encodeURIComponent(active) + "/ui";
        return;
      }
    } catch {
      // ignore
    }
    appendMsg("system", "No workspace configured.");
    return;
  }

  setRun("idle");
  clearTimeline();
  if (workspaceUrlEl) {
    const wsUrl = location.origin + "/w/" + encodeURIComponent(workspaceId);
    workspaceUrlEl.textContent = wsUrl;
    workspaceUrlEl.href = wsUrl;
  }

  await refreshHost(workspaceId);
  sessionIdEl.textContent = readSessionId(workspaceId) ? ("session: " + readSessionId(workspaceId)) : "session: -";
  await refreshMessages(workspaceId).catch(() => undefined);

  setTab(activeTab);
  if (tabsEl) {
    const buttons = tabsEl.querySelectorAll(".tab");
    buttons.forEach((btn) => {
      btn.onclick = async () => {
        const tab = btn.getAttribute("data-tab") || "share";
        setTab(tab);
        try {
          if (tab === "automations") await refreshAutomations(workspaceId);
          if (tab === "skills") await refreshSkills(workspaceId);
          if (tab === "plugins") await refreshPlugins(workspaceId);
          if (tab === "apps") await refreshMcp(workspaceId);
          if (tab === "share") await refreshTokens().catch(() => undefined);
        } catch {
          // ignore
        }
      };
    });
  }
  if (autoKindEl) {
    autoKindEl.onchange = () => updateAutomationScheduleUI();
    updateAutomationScheduleUI();
  }

  qs("#btn-new").onclick = async () => {
    try {
      writeSessionId(workspaceId, "");
      const id = await ensureSession(workspaceId);
      sessionIdEl.textContent = "session: " + id;
      await refreshMessages(workspaceId);
    } catch (e) {
      setStatus(e && e.message ? e.message : "Failed to create session", "bad");
    }
  };

  qs("#btn-refresh").onclick = async () => {
    await refreshMessages(workspaceId).catch((e) => setStatus(e && e.message ? e.message : "refresh failed", "bad"));
  };

  qs("#btn-delete-session").onclick = async () => {
    const sessionId = readSessionId(workspaceId);
    if (!sessionId) {
      setStatus("No session selected", "bad");
      return;
    }
    if (!confirm("Delete this session? This cannot be undone.")) return;
    try {
      await apiFetch(
        "/workspace/" + encodeURIComponent(workspaceId) + "/sessions/" + encodeURIComponent(sessionId),
        { method: "DELETE" },
      );
      writeSessionId(workspaceId, "");
      sessionIdEl.textContent = "session: -";
      chatlog.innerHTML = "";
      clearTimeline();
      setRun("idle");
      setStatus("Session deleted", "ok");
    } catch (e) {
      setStatus(e && e.message ? e.message : "delete failed", "bad");
    }
  };

  qs("#btn-send").onclick = async () => {
    const text = (promptEl.value || "").trim();
    if (!text) return;
    clearTimeline();
    addCheckpoint("prompt.submitted", text.length > 120 ? (text.slice(0, 120) + "...") : text);
    setRun("running");
    void connectSse(workspaceId).catch(() => undefined);
    appendMsg("user", text);
    promptEl.value = "";
    try {
      const sessionId = await ensureSession(workspaceId);
      sessionIdEl.textContent = "session: " + sessionId;
      const model = await resolveDefaultModel(workspaceId);
      const body = { parts: [{ type: "text", text: text }] };
      if (model) body.model = model;
      await apiFetch(
        "/w/" + encodeURIComponent(workspaceId) + "/opencode/session/" + encodeURIComponent(sessionId) + "/prompt_async",
        { method: "POST", body: JSON.stringify(body) },
      );
      setStatus("Prompt accepted", "ok");
      addCheckpoint("prompt.accepted");
      await refreshMessages(workspaceId).catch(() => undefined);
    } catch (e) {
      setStatus(e && e.message ? e.message : "Prompt failed", "bad");
      addCheckpoint("prompt.failed", e && e.message ? e.message : "Prompt failed");
      setRun("idle");
    }
  };

  qs("#btn-skill").onclick = () => {
    const template = [
      "Turn this into a skill.",
      "",
      "Requirements:",
      "- Skill name: my-skill",
      "- Write to .opencode/skills/my-skill/SKILL.md",
      "- Include usage, inputs, steps, and examples",
      "",
      "Use the most recent conversation as source material.",
    ].join("\n");
    const existing = (promptEl.value || "").trim();
    promptEl.value = existing ? (existing + "\n\n" + template) : template;
    promptEl.focus();
  };

  qs("#btn-mint").onclick = async () => {
    try {
      await mintShareToken(workspaceId);
    } catch (e) {
      setStatus(e && e.message ? e.message : "Token mint failed", "bad");
    }
  };

  qs("#btn-deploy").onclick = () => {
    setStatus("Deploy (Beta) is not implemented in the Toy UI yet", "");
  };

  qs("#btn-events").onclick = async () => {
    try {
      await connectSse(workspaceId);
    } catch (e) {
      setStatus(e && e.message ? e.message : "SSE failed", "bad");
    }
  };

  qs("#btn-events-stop").onclick = () => stopSse();

  qs("#btn-upload").onclick = async () => {
    const input = qs("#file");
    const file = input && input.files && input.files[0] ? input.files[0] : null;
    if (!file) {
      setStatus("Pick a file first", "bad");
      return;
    }
    try {
      const form = new FormData();
      form.set("file", file);
      await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/inbox", { method: "POST", body: form });
      setStatus("Uploaded", "ok");
    } catch (e) {
      setStatus(e && e.message ? e.message : "Upload failed", "bad");
    }
  };

  qs("#btn-artifacts").onclick = async () => {
    await listArtifacts(workspaceId).catch((e) => setStatus(e && e.message ? e.message : "artifacts failed", "bad"));
  };

  qs("#btn-approvals").onclick = async () => {
    await refreshApprovals().catch(() => undefined);
  };

  qs("#btn-share").onclick = async () => {
    await showConnectArtifact(workspaceId).catch(() => undefined);
  };

  qs("#btn-copy").onclick = async () => {
    await copyConnectArtifact();
  };

  qs("#btn-tokens").onclick = async () => {
    await refreshTokens().catch((e) => setStatus(e && e.message ? e.message : "tokens failed", "bad"));
  };

  qs("#btn-export").onclick = async () => {
    try {
      await exportWorkspace(workspaceId);
      setStatus("Exported", "ok");
    } catch (e) {
      setStatus(e && e.message ? e.message : "export failed", "bad");
    }
  };

  qs("#btn-import").onclick = async () => {
    try {
      await importWorkspace(workspaceId);
      setStatus("Import requested (check approvals)", "ok");
    } catch (e) {
      setStatus(e && e.message ? e.message : "import failed", "bad");
    }
  };

  qs("#btn-delete-workspace").onclick = async () => {
    if (!confirm("Delete this workspace from the host's OpenWork server config?")) return;
    try {
      await apiFetch("/workspaces/" + encodeURIComponent(workspaceId), { method: "DELETE" });
      setStatus("Workspace deleted (refresh workspaces)", "ok");
    } catch (e) {
      setStatus(e && e.message ? e.message : "workspace delete failed", "bad");
    }
  };

  qs("#btn-auto-refresh").onclick = async () => {
    await refreshAutomations(workspaceId).catch((e) => setStatus(e && e.message ? e.message : "automations failed", "bad"));
  };

  qs("#btn-auto-save").onclick = async () => {
    try {
      await saveAutomation(workspaceId);
      if (autoNameEl) autoNameEl.value = "";
      if (autoPromptEl) autoPromptEl.value = "";
      await refreshAutomations(workspaceId);
      setStatus("Automation saved (apply schedule on host)", "ok");
    } catch (e) {
      setStatus(e && e.message ? e.message : "automation save failed", "bad");
    }
  };

  qs("#btn-skills-refresh").onclick = async () => {
    await refreshSkills(workspaceId).catch((e) => setStatus(e && e.message ? e.message : "skills failed", "bad"));
  };

  qs("#btn-plugins-refresh").onclick = async () => {
    await refreshPlugins(workspaceId).catch((e) => setStatus(e && e.message ? e.message : "plugins failed", "bad"));
  };

  qs("#btn-plugin-add").onclick = async () => {
    const spec = pluginSpecEl && pluginSpecEl.value ? String(pluginSpecEl.value).trim() : "";
    if (!spec) {
      setStatus("plugin spec required", "bad");
      return;
    }
    try {
      await apiFetch("/workspace/" + encodeURIComponent(workspaceId) + "/plugins", {
        method: "POST",
        body: JSON.stringify({ spec }),
      });
      if (pluginSpecEl) pluginSpecEl.value = "";
      await refreshPlugins(workspaceId);
      setStatus("Plugin added", "ok");
    } catch (e) {
      setStatus(e && e.message ? e.message : "plugin add failed", "bad");
    }
  };

  qs("#btn-mcp-refresh").onclick = async () => {
    await refreshMcp(workspaceId).catch((e) => setStatus(e && e.message ? e.message : "mcp failed", "bad"));
  };
}

main().catch((e) => {
  setStatus(e && e.message ? e.message : "Startup failed", "bad");
});
`;

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function cssResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function jsResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
