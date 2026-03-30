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
    <link rel="icon" type="image/svg+xml" href="/ui/assets/openwork-mark.svg" />
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

export const TOY_UI_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 834 649" fill="none"><path fill="#011627" d="M445.095 7.09371C465.376 6.15629 479.12 14.7057 495.962 24.2006L526.535 41.3366L562.91 61.6421C572.209 66.8088 584.43 72.9805 592.216 79.7283C605.112 90.9218 613.007 107.518 613.57 124.621C613.997 137.564 613.785 151.186 613.771 164.285L613.743 233.167L613.724 302.115C613.724 328.043 615.147 351.097 609.112 376.5C602.601 403.733 589.274 428.855 570.372 449.495C549.311 472.84 531.218 480.587 504.269 495.433L435.717 533.297L369.268 570.017C349.148 581.007 338.445 590.166 314.978 591.343C295.336 592.765 280.624 583.434 264.332 574.332L231.209 555.796L197.159 536.707C188.064 531.606 176.78 525.84 169.138 519.247C155.537 507.509 147.236 489.12 146.689 471.221C146.261 457.224 146.479 442.102 146.479 427.951L146.495 345.546L146.52 273.548C146.53 254.27 145.49 230.956 149.51 212.464C154.532 189.864 165.167 168.888 180.427 151.489C188.245 142.605 197.223 134.814 207.121 128.324C220.854 119.307 239.559 109.953 254.414 101.931L324.032 63.8708L377.708 34.3028C389.942 27.4909 403.011 19.8636 415.79 14.2429C424.983 10.1982 434.435 8.96958 445.095 7.09371Z" /><path fill="#FFFFFF" d="M551.317 90.4398C557.678 89.5674 565.764 91.1466 571.495 93.8628C579.57 97.6845 585.756 104.611 588.643 113.063C593.053 125.734 591.473 156.67 591.443 171.112L591.314 249.733L591.238 310.947C591.227 325.186 591.691 340.89 590.054 354.92C588.069 370.594 583.473 385.826 576.46 399.982C555.363 442.986 527.973 455.45 488.286 477.122L422.355 513.332L365.248 544.928C353.229 551.61 337.931 561.062 325.256 565.404C303.927 570.03 288.668 560.584 286.41 537.983C285.155 525.413 285.813 512.071 285.819 499.363L285.877 428.201L285.838 335.271C285.834 319.126 284.849 293.286 287.551 278.43C291.03 259.848 299.063 242.413 310.931 227.699C318.408 218.335 327.295 210.186 337.275 203.548C346.99 197.101 362.755 189.212 373.491 183.383L431.093 151.71L500.183 113.742C508.673 109.063 517.232 104.321 525.662 99.5446C534.307 94.6455 540.968 91.4752 551.317 90.4398Z" /><path fill="#011627" d="M500.082 178.001C526.778 177.772 523.894 205.211 523.884 223.719L523.898 262.499L523.914 317.09C523.91 328.358 524.422 343.13 522.698 354.018C520.708 366.296 516.186 378.028 509.412 388.459C503.656 397.432 496.335 405.297 487.795 411.689C481.432 416.447 474.925 419.72 467.987 423.536L442.835 437.398L405.739 457.871C398 462.106 386.024 469.486 377.74 471.261L377.429 471.295C371.837 471.855 366.369 470.989 361.995 467.199C353.196 459.977 353.708 447.985 353.675 437.935C353.658 432.922 353.668 427.909 353.67 422.896L353.695 376.464L353.657 326.944C353.647 313.866 353.091 297.438 355.615 284.836C358.159 272.209 363.878 260.447 372.266 250.342C376.745 244.958 381.997 240.295 387.801 236.377C393.985 232.272 401.996 228.073 408.612 224.459L440.329 207.201L468.44 191.684C477.65 186.588 489.038 179.021 500.082 178.001Z" /><path fill="#FFFFFF" d="M500.225 291.464L500.59 291.556C501.213 292.643 501.002 340.865 500.638 345.536C500.306 350.339 499.443 355.09 498.065 359.703C494.788 370.842 488.588 380.902 480.112 388.834C472.165 396.184 462.79 400.931 453.37 406.067L431.052 418.227L377.328 447.628L376.894 447.414C376.568 445.467 376.757 441.034 376.763 438.896L376.794 421.911C376.893 401.013 376.885 380.115 376.77 359.217C382.142 355.849 390.96 351.452 396.691 348.372L427.925 331.276L469.656 308.362C479.711 302.761 490.055 296.768 500.225 291.464Z" /><path fill="#FFFFFF" d="M497.337 201.62C500.344 201.36 500.962 203.237 501.131 205.91C501.599 213.274 501.389 220.747 501.367 228.135L501.431 265.103C460.969 287.74 420.329 310.058 379.523 332.068L376.452 333.794C376.365 312.962 373.253 285.726 386.024 268.182C393.365 258.104 404.145 253.143 414.788 247.296L441.211 232.769L476.823 212.874C483.353 209.216 490.623 204.921 497.337 201.62Z" /><path fill="#FFFFFF" d="M443.216 29.48C452.02 29.0815 460.018 30.0261 467.903 34.1434C489.625 45.4892 510.693 58.4477 532.373 69.8693C514.905 78.2946 493.564 90.995 476.372 100.542L386.895 149.628C376.357 155.498 365.774 161.287 355.148 166.992C337.373 176.588 322.776 183.695 307.595 197.464C287.772 215.608 273.675 239.14 267.014 265.17C262.116 284.284 262.909 298.302 262.917 317.836L262.939 357.47L262.926 471.524L262.961 530.447C262.98 532.198 263.562 543.941 263.164 544.751L262.58 544.549L215.582 518.061C189.232 503.261 169.189 495.747 169.845 460.795C170.068 448.934 169.804 435.617 169.812 423.605L169.831 344.391L169.818 269.769C169.814 254.383 168.977 231.859 171.873 217.311C175.825 198.048 184.641 180.127 197.478 165.236C204.056 157.596 211.686 150.929 220.143 145.432C231.916 137.708 249.246 128.979 262.061 121.995L328.787 85.3185L391.28 50.97C401.594 45.3095 412 39.3027 422.528 34.3441C428.812 31.3849 436.148 30.2484 443.216 29.48Z" /></svg>`;

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

export function svgResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
