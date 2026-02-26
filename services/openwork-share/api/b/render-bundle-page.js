const OPENWORK_SITE_URL = "https://openwork.software";
const OPENWORK_DOWNLOAD_URL = "https://openwork.software/download";
const OPENWORK_APP_URL =
  typeof process.env.PUBLIC_OPENWORK_APP_URL === "string" && process.env.PUBLIC_OPENWORK_APP_URL.trim()
    ? process.env.PUBLIC_OPENWORK_APP_URL.trim()
    : "https://app.openwork.software";

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

function maybeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function maybeArray(value) {
  return Array.isArray(value) ? value : [];
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

function normalizeAppUrl(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function buildOpenInAppUrls(shareUrl, options = {}) {
  const query = new URLSearchParams();
  query.set("ow_bundle", shareUrl);
  query.set("ow_intent", "new_worker");
  query.set("ow_source", "share_service");

  const label = String(options.label ?? "").trim();
  if (label) {
    query.set("ow_label", label.slice(0, 120));
  }

  const openInAppDeepLink = `openwork://import-bundle?${query.toString()}`;

  const appUrl = normalizeAppUrl(OPENWORK_APP_URL) || "https://app.openwork.software";
  try {
    const url = new URL(appUrl);
    for (const [key, value] of query.entries()) {
      url.searchParams.set(key, value);
    }
    return {
      openInAppDeepLink,
      openInWebAppUrl: url.toString(),
    };
  } catch {
    return {
      openInAppDeepLink,
      openInWebAppUrl: `${"https://app.openwork.software"}?${query.toString()}`,
    };
  }
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
        workspace: null,
        skills: [],
        commands: [],
      };
    }

    const workspace = maybeObject(parsed.workspace);
    const skills = maybeArray(parsed.skills);
    const commands = maybeArray(parsed.commands);

    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null,
      type: maybeString(parsed.type).trim(),
      name: maybeString(parsed.name).trim(),
      description: maybeString(parsed.description).trim(),
      trigger: maybeString(parsed.trigger).trim(),
      content: maybeString(parsed.content),
      workspace,
      skills,
      commands,
    };
  } catch {
    return {
      schemaVersion: null,
      type: "",
      name: "",
      description: "",
      trigger: "",
      content: "",
      workspace: null,
      skills: [],
      commands: [],
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

function listCount(value) {
  return Array.isArray(value) ? value.length : 0;
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
  const { openInAppDeepLink, openInWebAppUrl } = buildOpenInAppUrls(urls.shareUrl, {
    label: bundle.name || "Shared setup",
  });
  const prettyBundleJson = prettyJson(rawJson);
  const schemaVersion = bundle.schemaVersion == null ? "unknown" : String(bundle.schemaVersion);
  const typeLabel = humanizeType(bundle.type);
  const title = bundle.name || `OpenWork ${typeLabel}`;
  const description =
    bundle.description ||
    "OpenWork share links stay human-friendly for reading while still exposing a stable machine-readable JSON bundle.";
  
  const workspaceSkills = listCount(bundle.workspace?.skills);
  const workspaceCommands = listCount(bundle.workspace?.commands);
  const workspaceHasConfig = Boolean(maybeObject(bundle.workspace?.opencode) || maybeObject(bundle.workspace?.openwork));
  const skillsSetCount = listCount(bundle.skills);
  
  const installHint =
    bundle.type === "skill"
      ? "Use Open in app to create a new worker and install this skill."
      : bundle.type === "skills-set"
        ? "Use Open in app to create a new worker and import this full skills set."
        : bundle.type === "workspace-profile"
          ? "Use Open in app to create a new worker from this full workspace profile (config, MCP, commands, and skills)."
          : "Use the JSON endpoint if you want to import this bundle programmatically.";
          
  const contentLabel = bundle.type === "skill" && bundle.content.trim() ? "Skill content" : "Bundle payload";
  const contentPreview =
    bundle.type === "skill" && bundle.content.trim() ? truncate(bundle.content.trim()) : truncate(prettyBundleJson);

  let metadataExtras = "";
  if (bundle.type === "workspace-profile") {
    metadataExtras = `
          <div class="meta-row">
            <dt class="meta-label">Skills</dt>
            <dd class="meta-value">${escapeHtml(String(workspaceSkills))}</dd>
          </div>
          <div class="meta-row">
            <dt class="meta-label">Commands</dt>
            <dd class="meta-value">${escapeHtml(String(workspaceCommands))}</dd>
          </div>
          <div class="meta-row">
            <dt class="meta-label">Config</dt>
            <dd class="meta-value">${escapeHtml(workspaceHasConfig ? "yes" : "no")}</dd>
          </div>`;
  } else if (bundle.type === "skills-set") {
    metadataExtras = `
          <div class="meta-row">
            <dt class="meta-label">Skills</dt>
            <dd class="meta-value">${escapeHtml(String(skillsSetCount))}</dd>
          </div>`;
  }

  // Generate an avatar letter from the name
  const avatarLetter = (bundle.name || "M").charAt(0).toUpperCase();

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
  <meta name="openwork:open-in-app-url" content="${escapeHtml(openInAppDeepLink)}" />
  <link rel="alternate" type="application/json" href="${escapeHtml(urls.jsonUrl)}" />
  <style>
    :root {
      color-scheme: only light;
      --bg-canvas: #f5f5f5; /* neutral-100 */
      --bg-surface: #ffffff; /* white */
      --bg-secondary: #fafafa; /* neutral-50 */
      --bg-hover: rgba(245, 245, 245, 0.8); /* neutral-100/80 */
      
      --text-primary: #171717; /* neutral-900 */
      --text-secondary: #737373; /* neutral-500 */
      --text-muted: #a3a3a3; /* neutral-400 */
      
      --accent-primary: #171717; /* neutral-900 */
      --accent-hover: #262626; /* neutral-800 */
      --accent-ink: #ffffff; /* white */
      
      --border-primary: #e5e5e5; /* neutral-200 */
      --border-hover: #d4d4d4; /* neutral-300 */
      
      --code-bg: #fafafa; /* neutral-50 */
      
      --font-sans: "Avenir Next", "Segoe UI Variable", "Segoe UI", "Inter", sans-serif;
      --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", monospace;
    }
    
    * { box-sizing: border-box; }
    
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--font-sans);
      color: var(--text-primary);
      background-color: var(--bg-canvas);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    
    /* The Modal Container */
    .modal-container {
      background: var(--bg-surface);
      width: 100%;
      max-width: 32rem; /* max-w-lg (512px) */
      border-radius: 1rem; /* rounded-2xl */
      box-shadow: 0 20px 50px -12px rgba(0,0,0,0.15);
      border: 1px solid var(--border-primary);
      overflow: hidden;
      animation: zoomIn 300ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    @keyframes zoomIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    
    /* Header Section */
    .header {
      padding: 1.5rem 1.5rem 1rem;
      position: relative;
      border-bottom: 1px solid transparent;
    }
    
    .close-btn {
      position: absolute;
      top: 1.5rem;
      right: 1.5rem;
      padding: 0.375rem;
      color: var(--text-muted);
      background: transparent;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
    }
    
    .close-btn:hover {
      color: var(--text-secondary);
      background: var(--bg-canvas);
    }
    
    .header-content {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    
    .avatar {
      width: 2.5rem;
      height: 2.5rem;
      background: var(--accent-primary);
      border-radius: 0.75rem; /* rounded-xl */
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent-ink);
      font-weight: 700;
      font-size: 1.125rem;
    }
    
    .title-area h1 {
      margin: 0;
      font-size: 17px; /* text-[17px] */
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.025em; /* tracking-tight */
    }
    
    .subtitle-area {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.125rem;
    }
    
    .subtitle-text {
      font-size: 13px; /* text-[13px] */
      font-weight: 600;
      color: #404040; /* neutral-700 */
    }
    
    .dot {
      width: 4px;
      height: 4px;
      border-radius: 9999px;
      background: #d4d4d4; /* neutral-300 */
    }
    
    .subtitle-type {
      font-size: 12px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
    }
    
    /* Main Content Area */
    .main-content {
      padding: 0 1.5rem 2rem;
      max-height: 500px;
      overflow-y: auto;
      scrollbar-width: none; /* Firefox */
      position: relative;
    }
    .main-content::-webkit-scrollbar {
      display: none; /* Safari and Chrome */
    }
    
    /* Tab Intro */
    .tab-intro {
      margin-top: 0.5rem;
      margin-bottom: 1rem;
    }
    
    .tab-intro p {
      margin: 0;
      font-size: 14px;
      color: #525252; /* neutral-600 */
      font-weight: 500;
    }
    
    .tab-intro span {
      display: block;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 0.125rem;
    }
    
    /* Cards */
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      border-radius: 1rem; /* rounded-2xl */
      padding: 1rem;
      box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); /* shadow-sm */
      transition: all 0.2s;
      margin-bottom: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    
    .card:hover {
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1); /* shadow-md */
      border-color: var(--border-hover);
    }
    
    .card-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }
    
    .card-icon {
      padding: 0.5rem;
      background: var(--bg-secondary);
      border-radius: 0.5rem; /* rounded-lg */
      color: var(--text-secondary);
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .card:hover .card-icon {
      color: var(--text-primary);
      background: var(--bg-hover);
    }
    
    .card-title-area h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
    }
    
    .card-title-area p {
      margin: 0;
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.25; /* leading-tight */
    }
    
    /* Buttons */
    .btn-primary {
      width: 100%;
      padding: 0.625rem;
      background: var(--accent-primary);
      color: var(--accent-ink);
      font-size: 13px;
      font-weight: 700;
      font-family: var(--font-sans);
      border: none;
      border-radius: 0.75rem; /* rounded-xl */
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
      text-decoration: none;
      display: inline-block;
    }
    
    .btn-primary:hover {
      background: var(--accent-hover);
    }
    
    .btn-primary:active {
      transform: scale(0.98);
    }
    
    .btn-secondary {
      width: 100%;
      padding: 0.625rem;
      background: #f5f5f5; /* neutral-100 */
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 700;
      font-family: var(--font-sans);
      border: none;
      border-radius: 0.75rem; /* rounded-xl */
      cursor: pointer;
      transition: all 0.2s;
      text-align: center;
      text-decoration: none;
      display: inline-block;
    }
    
    .btn-secondary:hover {
      background: #e5e5e5; /* neutral-200 */
    }
    
    /* Input Group */
    .input-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      animation: fadeIn 200ms ease;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    .input-field {
      flex: 1;
      background: var(--bg-secondary);
      border: 1px solid var(--border-primary);
      border-radius: 0.5rem; /* rounded-lg */
      padding: 0.5rem 0.75rem;
      font-size: 12px;
      font-family: var(--font-mono);
      color: #525252; /* neutral-600 */
      outline: none;
      width: 100%;
    }
    
    .input-field:focus {
      border-color: var(--border-hover);
    }
    
    .btn-icon {
      padding: 0.5rem;
      background: var(--accent-primary);
      color: var(--accent-ink);
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }
    
    .btn-icon:hover {
      background: var(--accent-hover);
    }
    
    .btn-icon.secondary-icon {
      background: transparent;
      color: var(--text-muted);
    }
    
    .btn-icon.secondary-icon:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
    
    /* Download Section */
    .download-section {
      padding-top: 1rem;
      margin-top: 0.5rem;
      border-top: 1px solid #f5f5f5; /* neutral-100 */
    }
    
    .download-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem;
      background: var(--bg-secondary);
      border-radius: 1rem; /* rounded-2xl */
      border: 1px solid transparent;
      transition: all 0.2s;
      text-decoration: none;
    }
    
    .download-row:hover {
      background: rgba(245, 245, 245, 0.5); /* neutral-100/50 */
      border-color: var(--border-primary);
    }
    
    .download-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    
    .download-icon {
      padding: 0.5rem;
      background: var(--bg-surface);
      border-radius: 0.5rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .download-text h4 {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-primary);
    }
    
    .download-text p {
      margin: 0;
      font-size: 12px;
      color: var(--text-secondary);
    }
    
    .btn-outline {
      padding: 0.5rem 1rem;
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      border-radius: 0.75rem; /* rounded-xl */
      font-size: 12px;
      font-weight: 700;
      color: #525252; /* neutral-600 */
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      text-decoration: none;
    }
    
    .download-row:hover .btn-outline {
      border-color: var(--text-primary);
      color: var(--text-primary);
    }
    
    /* Raw Content Area */
    .raw-content {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-primary);
    }
    
    .raw-content h3 {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0 0 0.5rem 0.25rem;
    }
    
    .raw-content pre {
      margin: 0;
      padding: 1rem;
      background: var(--code-bg);
      border: 1px solid var(--border-primary);
      border-radius: 0.75rem;
      font-family: var(--font-mono);
      font-size: 12px;
      color: #404040;
      overflow-x: auto;
      max-height: 200px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    
    /* Footer fade */
    .footer-fade {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2rem;
      background: linear-gradient(to top, var(--bg-surface), transparent);
      pointer-events: none;
      border-bottom-left-radius: 1rem;
      border-bottom-right-radius: 1rem;
    }
    
    /* Meta Details Layout */
    .meta-details {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px dashed var(--border-primary);
    }
    
    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .meta-label {
      font-size: 12px;
      color: var(--text-secondary);
      margin: 0;
    }
    
    .meta-value {
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text-primary);
      margin: 0;
      font-weight: 500;
    }
    
    /* Toast */
    .toast {
      position: fixed;
      bottom: 1.5rem;
      left: 50%;
      transform: translateX(-50%) translateY(1rem);
      background: var(--text-primary);
      color: var(--bg-surface);
      padding: 0.5rem 1rem;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
      opacity: 0;
      pointer-events: none;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 50;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .toast.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    
    .btn-icon svg {
      width: 16px;
      height: 16px;
    }
  </style>
</head>
<body
  data-openwork-share="true"
  data-openwork-bundle-id="${escapeHtml(id)}"
  data-openwork-bundle-type="${escapeHtml(bundle.type || "unknown")}" 
  data-openwork-schema-version="${escapeHtml(schemaVersion)}"
>
  <div class="modal-container">
    <div class="header">
      <a href="${OPENWORK_SITE_URL}" target="_blank" rel="noreferrer" class="close-btn" aria-label="Close">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </a>
      
      <div class="header-content">
        <div class="avatar">${escapeHtml(avatarLetter)}</div>
        <div class="title-area">
          <h1>OpenWork Share</h1>
          <div class="subtitle-area">
            <span class="subtitle-text">${escapeHtml(title)}</span>
            <span class="dot"></span>
            <span class="subtitle-type">.../${escapeHtml(id.slice(-8))}</span>
          </div>
        </div>
      </div>
    </div>
    
    <div class="main-content">
      <div class="tab-intro">
        <p>Shared configuration bundle</p>
        <span>${escapeHtml(description)}</span>
      </div>
      
      <div class="card">
        <div class="card-header">
          <div class="card-icon">
            <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </div>
          <div class="card-title-area">
            <h3>${escapeHtml(typeLabel)}</h3>
            <p>${escapeHtml(installHint)}</p>
          </div>
        </div>
        
        <a href="${escapeHtml(openInAppDeepLink)}" class="btn-primary">Open in App</a>
        
        <div class="input-group">
          <input type="text" class="input-field" value="${escapeHtml(urls.shareUrl)}" readonly id="share-url-input" />
          <button type="button" class="btn-icon" id="copy-link-btn" aria-label="Copy link">
            <svg viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          </button>
        </div>
        
        <div class="meta-details">
          <div class="meta-row">
            <dt class="meta-label">ID</dt>
            <dd class="meta-value">${escapeHtml(id)}</dd>
          </div>
          <div class="meta-row">
            <dt class="meta-label">Type</dt>
            <dd class="meta-value">${escapeHtml(bundle.type || "unknown")}</dd>
          </div>
          ${metadataExtras}
        </div>
      </div>
      
      <div class="download-section">
        <a href="${escapeHtml(urls.downloadUrl)}" class="download-row">
          <div class="download-info">
            <div class="download-icon">
              <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
            </div>
            <div class="download-text">
              <h4>Download JSON</h4>
              <p>Save configuration bundle locally</p>
            </div>
          </div>
          <span class="btn-outline">Download</span>
        </a>
      </div>
      
      <div class="raw-content">
        <h3>${escapeHtml(contentLabel)} Preview</h3>
        <pre>${escapeHtml(contentPreview)}</pre>
      </div>
      
    </div>
    
    <div class="footer-fade"></div>
  </div>

  <script id="openwork-bundle-json" type="application/json">${escapeJsonForScript(rawJson)}</script>
  
  <div class="toast" id="toast-message" role="status" aria-live="polite">
    <svg viewBox="0 0 24 24" style="width: 14px; height: 14px;"><path d="M20 6 9 17l-5-5"/></svg>
    <span>Copied</span>
  </div>
  
  <script>
    const shareUrl = ${JSON.stringify(urls.shareUrl)};
    const toastNode = document.getElementById("toast-message");

    function showToast(text) {
      if (!toastNode) return;
      toastNode.querySelector('span').textContent = text;
      toastNode.classList.add("visible");
      window.setTimeout(() => toastNode.classList.remove("visible"), 2000);
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
        showToast(label + " copied");
      } catch {
        showToast("Copy failed");
      }
    }

    document.getElementById("copy-link-btn")?.addEventListener("click", () => {
      copyText(shareUrl, "Link");
      
      // Select input text for visual feedback
      const input = document.getElementById("share-url-input");
      if (input) {
        input.select();
      }
    });
  </script>
</body>
</html>`;
}
