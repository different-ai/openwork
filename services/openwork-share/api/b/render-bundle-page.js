const OPENWORK_SITE_URL = "https://openwork.software";
const OPENWORK_DOWNLOAD_URL = "https://openwork.software/download";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJsonForScript(rawJson) {
  return rawJson
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function maybeString(value) {
  return typeof value === "string" ? value : "";
}

function humanizeType(type) {
  if (!type) return "Bundle";
  return type
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function truncate(value, maxChars = 3200) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n... (truncated for display)`;
}

function parseBundle(rawJson) {
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object") {
      return {
        schemaVersion: null,
        type: "",
        name: "",
        description: "",
        trigger: "",
        content: "",
      };
    }

    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null,
      type: maybeString(parsed.type).trim(),
      name: maybeString(parsed.name).trim(),
      description: maybeString(parsed.description).trim(),
      trigger: maybeString(parsed.trigger).trim(),
      content: maybeString(parsed.content),
    };
  } catch {
    return {
      schemaVersion: null,
      type: "",
      name: "",
      description: "",
      trigger: "",
      content: "",
    };
  }
}

function prettyJson(rawJson) {
  try {
    return JSON.stringify(JSON.parse(rawJson), null, 2);
  } catch {
    return rawJson;
  }
}

function getOrigin(req) {
  const protocolHeader = String(req.headers?.["x-forwarded-proto"] ?? "https").split(",")[0].trim();
  const hostHeader = String(req.headers?.["x-forwarded-host"] ?? req.headers?.host ?? "")
    .split(",")[0]
    .trim();

  if (!hostHeader) return "";
  const protocol = protocolHeader || "https";
  return `${protocol}://${hostHeader}`;
}

export function buildBundleUrls(req, id) {
  const encodedId = encodeURIComponent(id);
  const origin = getOrigin(req);
  const path = `/b/${encodedId}`;

  return {
    shareUrl: origin ? `${origin}${path}` : path,
    jsonUrl: origin ? `${origin}${path}?format=json` : `${path}?format=json`,
    downloadUrl: origin ? `${origin}${path}?format=json&download=1` : `${path}?format=json&download=1`,
  };
}

export function wantsJsonResponse(req) {
  const format = String(req.query?.format ?? "").trim().toLowerCase();
  if (format === "json") return true;
  if (format === "html") return false;

  const accept = String(req.headers?.accept ?? "").toLowerCase();
  if (!accept) return true;
  if (accept.includes("application/json")) return true;
  if (accept.includes("text/html") || accept.includes("application/xhtml+xml")) return false;
  return true;
}

export function wantsDownload(req) {
  return String(req.query?.download ?? "").trim() === "1";
}

export function renderBundlePage({ id, rawJson, req }) {
  const bundle = parseBundle(rawJson);
  const urls = buildBundleUrls(req, id);
  const prettyBundleJson = prettyJson(rawJson);
  const schemaVersion = bundle.schemaVersion == null ? "unknown" : String(bundle.schemaVersion);
  const typeLabel = humanizeType(bundle.type);
  const title = bundle.name || `OpenWork ${typeLabel}`;
  const description =
    bundle.description ||
    "OpenWork share links stay human-friendly for reading while still exposing a stable machine-readable JSON bundle.";
  const installHint =
    bundle.type === "skill"
      ? "Open OpenWork, go to Skills, choose Install from link, then paste this URL."
      : "Use the JSON endpoint if you want to import this bundle programmatically.";
  const contentLabel = bundle.type === "skill" && bundle.content.trim() ? "Skill content" : "Bundle payload";
  const contentPreview =
    bundle.type === "skill" && bundle.content.trim() ? truncate(bundle.content.trim()) : truncate(prettyBundleJson);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - OpenWork Share</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="openwork:bundle-id" content="${escapeHtml(id)}" />
  <meta name="openwork:bundle-type" content="${escapeHtml(bundle.type || "unknown")}" />
  <meta name="openwork:schema-version" content="${escapeHtml(schemaVersion)}" />
  <link rel="alternate" type="application/json" href="${escapeHtml(urls.jsonUrl)}" />
  <style>
    :root {
      color-scheme: only light;
      --bg-top: #f4f0e8;
      --bg-bottom: #fdfbf8;
      --panel: rgba(255, 255, 255, 0.9);
      --panel-border: rgba(42, 38, 31, 0.12);
      --text-strong: #1d1a16;
      --text-muted: #5f5549;
      --accent: #0f6f61;
      --accent-ink: #f4fffc;
      --code-bg: #f7f5f2;
      --code-border: #dfd7cc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Avenir Next", "Segoe UI Variable", "Segoe UI", "Inter", sans-serif;
      color: var(--text-strong);
      background:
        radial-gradient(1200px 500px at 90% -100px, rgba(15, 111, 97, 0.14), transparent 70%),
        radial-gradient(1000px 420px at -10% -60px, rgba(220, 168, 121, 0.2), transparent 72%),
        linear-gradient(180deg, var(--bg-top), var(--bg-bottom));
      padding: 28px 16px 48px;
    }
    .page {
      margin: 0 auto;
      max-width: 980px;
      display: grid;
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 18px;
      box-shadow: 0 10px 30px rgba(37, 31, 21, 0.06);
      backdrop-filter: blur(6px);
      padding: 18px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text-strong);
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .brand-badge {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: #111;
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
    }
    .hero h1 {
      margin: 0;
      font-size: clamp(1.5rem, 2.4vw, 2.1rem);
      line-height: 1.2;
      letter-spacing: -0.02em;
    }
    .hero p {
      margin: 10px 0 0;
      color: var(--text-muted);
      line-height: 1.5;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 700;
      padding: 6px 10px;
      border-radius: 999px;
      background: #fff;
      border: 1px solid var(--panel-border);
      color: var(--text-muted);
      margin-bottom: 10px;
    }
    .actions {
      margin-top: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button,
    .action-link {
      border: 1px solid transparent;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 10px 12px;
      text-decoration: none;
      transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
    }
    button:hover,
    .action-link:hover {
      transform: translateY(-1px);
    }
    .primary {
      background: var(--accent);
      color: var(--accent-ink);
    }
    .secondary {
      border-color: var(--panel-border);
      color: var(--text-strong);
      background: rgba(255, 255, 255, 0.84);
    }
    .grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 1rem;
      letter-spacing: -0.01em;
    }
    .card ol {
      margin: 0;
      padding-left: 1.1rem;
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1.55;
      display: grid;
      gap: 3px;
    }
    .meta {
      margin: 0;
      display: grid;
      gap: 9px;
      font-size: 13px;
    }
    .meta div {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      color: var(--text-muted);
    }
    .meta dt {
      margin: 0;
      font-weight: 600;
    }
    .meta dd {
      margin: 0;
      color: var(--text-strong);
      font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", monospace;
      text-align: right;
    }
    .mono {
      margin: 12px 0 0;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid var(--code-border);
      background: var(--code-bg);
      font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
      color: #2c241b;
    }
    pre {
      margin: 0;
      max-height: 350px;
      overflow: auto;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--code-border);
      background: var(--code-bg);
      color: #1f1a15;
      font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .notice {
      position: fixed;
      right: 16px;
      bottom: 16px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(15, 111, 97, 0.28);
      background: rgba(255, 255, 255, 0.95);
      color: #11453d;
      font-size: 13px;
      box-shadow: 0 8px 24px rgba(31, 25, 18, 0.12);
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
      transition: opacity 150ms ease, transform 150ms ease;
    }
    .notice.visible {
      opacity: 1;
      transform: translateY(0);
    }
    @media (max-width: 640px) {
      body { padding: 16px 10px 36px; }
      .card { padding: 14px; border-radius: 14px; }
      .actions { display: grid; grid-template-columns: 1fr; }
    }
  </style>
</head>
<body
  data-openwork-share="true"
  data-openwork-bundle-id="${escapeHtml(id)}"
  data-openwork-bundle-type="${escapeHtml(bundle.type || "unknown")}" 
  data-openwork-schema-version="${escapeHtml(schemaVersion)}"
>
  <main class="page">
    <section class="card topbar">
      <a class="brand" href="${OPENWORK_SITE_URL}" target="_blank" rel="noreferrer">
        <span class="brand-badge">O</span>
        <span>OpenWork Share</span>
      </a>
      <a class="action-link secondary" href="${OPENWORK_DOWNLOAD_URL}" target="_blank" rel="noreferrer">Get OpenWork</a>
    </section>

    <section class="card hero">
      <div class="chip">${escapeHtml(typeLabel)}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <div class="actions">
        <button type="button" class="primary" id="copy-link-button">Copy share link</button>
        <button type="button" class="secondary" id="copy-json-button">Copy bundle JSON</button>
        <a class="action-link secondary" href="${escapeHtml(urls.jsonUrl)}" target="_blank" rel="noreferrer">View raw JSON</a>
        <a class="action-link secondary" href="${escapeHtml(urls.downloadUrl)}">Download JSON</a>
      </div>
    </section>

    <div class="grid">
      <section class="card">
        <h2>Install in OpenWork</h2>
        <ol>
          <li>${escapeHtml(installHint)}</li>
          <li>If you are using the API directly, call this link with <code>?format=json</code>.</li>
        </ol>
        <div class="mono">${escapeHtml(urls.shareUrl)}</div>
      </section>

      <section class="card">
        <h2>Metadata</h2>
        <dl class="meta">
          <div><dt>Bundle id</dt><dd>${escapeHtml(id)}</dd></div>
          <div><dt>Type</dt><dd>${escapeHtml(bundle.type || "unknown")}</dd></div>
          <div><dt>Schema</dt><dd>${escapeHtml(schemaVersion)}</dd></div>
          <div><dt>Name</dt><dd>${escapeHtml(bundle.name || "n/a")}</dd></div>
          <div><dt>Trigger</dt><dd>${escapeHtml(bundle.trigger || "n/a")}</dd></div>
        </dl>
      </section>
    </div>

    <section class="card">
      <h2>${escapeHtml(contentLabel)}</h2>
      <pre>${escapeHtml(contentPreview)}</pre>
    </section>

    <section class="card">
      <h2>Bundle JSON</h2>
      <pre>${escapeHtml(prettyBundleJson)}</pre>
    </section>
  </main>

  <script id="openwork-bundle-json" type="application/json">${escapeJsonForScript(rawJson)}</script>
  <div class="notice" id="copy-notice" role="status" aria-live="polite"></div>
  <script>
    const shareUrl = ${JSON.stringify(urls.shareUrl)};
    const jsonNode = document.getElementById("openwork-bundle-json");
    const copyNotice = document.getElementById("copy-notice");

    function showNotice(text) {
      if (!copyNotice) return;
      copyNotice.textContent = text;
      copyNotice.classList.add("visible");
      window.setTimeout(() => copyNotice.classList.remove("visible"), 1800);
    }

    async function copyText(value, label) {
      if (!value) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = value;
          textarea.style.position = "fixed";
          textarea.style.left = "-99999px";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        showNotice(label + " copied");
      } catch {
        showNotice("Copy failed");
      }
    }

    document.getElementById("copy-link-button")?.addEventListener("click", () => {
      copyText(shareUrl, "Link");
    });

    document.getElementById("copy-json-button")?.addEventListener("click", () => {
      copyText(jsonNode ? jsonNode.textContent || "" : "", "JSON");
    });
  </script>
</body>
</html>`;
}
