import { parse as parseYaml } from "yaml";

export const OPENWORK_SITE_URL = "https://openwork.software";
export const OPENWORK_DOWNLOAD_URL = "https://openwork.software/download";
export const DEFAULT_PUBLIC_BASE_URL = "https://share.openwork.software";
export const DEFAULT_OPENWORK_APP_URL = "https://app.openwork.software";
export const SHARE_EASE = "cubic-bezier(0.31, 0.325, 0, 0.92)";

function maybeString(value) {
  return typeof value === "string" ? value : "";
}

export function maybeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function maybeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function getEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function normalizeBaseUrl(input) {
  return String(input ?? "").trim().replace(/\/+$/, "");
}

export function normalizeAppUrl(input) {
  return normalizeBaseUrl(input);
}

export function setCors(res, options = {}) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", options.methods ?? "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    options.headers ??
      "Content-Type,Accept,X-OpenWork-Bundle-Type,X-OpenWork-Schema-Version,X-OpenWork-Name",
  );
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeJsonForScript(rawJson) {
  return String(rawJson)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function humanizeType(type) {
  if (!type) return "Bundle";
  return String(type)
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function truncate(value, maxChars = 3200) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n... (truncated for display)`;
}

function getOrigin(req) {
  const protocolHeader = String(req.headers?.["x-forwarded-proto"] ?? "https")
    .split(",")[0]
    .trim();
  const hostHeader = String(req.headers?.["x-forwarded-host"] ?? req.headers?.host ?? "")
    .split(",")[0]
    .trim();

  if (!hostHeader) {
    return normalizeBaseUrl(getEnv("PUBLIC_BASE_URL", DEFAULT_PUBLIC_BASE_URL));
  }

  return `${protocolHeader || "https"}://${hostHeader}`;
}

export function buildRootUrl(req) {
  return normalizeBaseUrl(getOrigin(req)) || DEFAULT_PUBLIC_BASE_URL;
}

export function buildOgImageUrl(req, targetId = "root") {
  const origin = buildRootUrl(req);
  return `${origin}/og/${encodeURIComponent(targetId)}`;
}

export function buildBundleUrls(req, id) {
  const encodedId = encodeURIComponent(id);
  const origin = buildRootUrl(req);
  const path = `/b/${encodedId}`;

  return {
    shareUrl: `${origin}${path}`,
    jsonUrl: `${origin}${path}?format=json`,
    downloadUrl: `${origin}${path}?format=json&download=1`,
  };
}

export function buildOpenInAppUrls(shareUrl, options = {}) {
  const query = new URLSearchParams();
  query.set("ow_bundle", shareUrl);
  query.set("ow_intent", "new_worker");
  query.set("ow_source", "share_service");

  const label = String(options.label ?? "").trim();
  if (label) query.set("ow_label", label.slice(0, 120));

  const openInAppDeepLink = `openwork://import-bundle?${query.toString()}`;
  const appUrl = normalizeAppUrl(getEnv("PUBLIC_OPENWORK_APP_URL", DEFAULT_OPENWORK_APP_URL)) || DEFAULT_OPENWORK_APP_URL;

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
      openInWebAppUrl: `${DEFAULT_OPENWORK_APP_URL}?${query.toString()}`,
    };
  }
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

export function parseFrontmatter(content) {
  const text = String(content ?? "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: text };
  const raw = match[1] ?? "";
  let data = {};
  try {
    data = maybeObject(parseYaml(raw)) ?? {};
  } catch {
    data = {};
  }
  return { data, body: text.slice(match[0].length) };
}

function normalizeSkillItem(value) {
  const record = maybeObject(value);
  if (!record) return null;
  const name = maybeString(record.name).trim();
  const content = maybeString(record.content);
  if (!name || !content.trim()) return null;
  return {
    name,
    description: maybeString(record.description).trim(),
    trigger: maybeString(record.trigger).trim(),
    content,
  };
}

function normalizeCommandItem(value) {
  const record = maybeObject(value);
  if (!record) return null;
  const name = maybeString(record.name).trim();
  const template = maybeString(record.template);
  const content = maybeString(record.content);
  if (!name || (!template.trim() && !content.trim())) return null;
  return {
    name,
    description: maybeString(record.description).trim(),
    template,
    content,
    agent: maybeString(record.agent).trim(),
    model: maybeString(record.model).trim(),
    subtask: record.subtask === true,
  };
}

export function parseBundle(rawJson) {
  try {
    return normalizeBundleRecord(JSON.parse(rawJson));
  } catch {
    return normalizeBundleRecord(null);
  }
}

function normalizeBundleRecord(parsed) {
  const record = maybeObject(parsed);
  const workspace = maybeObject(record?.workspace);

  return {
    schemaVersion: typeof record?.schemaVersion === "number" ? record.schemaVersion : null,
    type: maybeString(record?.type).trim(),
    name: maybeString(record?.name).trim(),
    description: maybeString(record?.description).trim(),
    trigger: maybeString(record?.trigger).trim(),
    content: maybeString(record?.content),
    workspace,
    skills: maybeArray(record?.skills).map(normalizeSkillItem).filter(Boolean),
    commands: maybeArray(record?.commands).map(normalizeCommandItem).filter(Boolean),
  };
}

export function validateBundlePayload(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, message: "Invalid JSON" };
  }

  const bundle = normalizeBundleRecord(parsed);
  if (bundle.schemaVersion !== 1) {
    return { ok: false, message: "Unsupported bundle schema version" };
  }

  if (!["skill", "skills-set", "workspace-profile"].includes(bundle.type)) {
    return { ok: false, message: "Unsupported bundle type" };
  }

  if (bundle.type === "skill") {
    if (!bundle.name || !bundle.content.trim()) {
      return { ok: false, message: "Skill bundles require name and content" };
    }
  }

  if (bundle.type === "skills-set") {
    if (!bundle.skills.length) {
      return { ok: false, message: "Skills set bundle has no importable skills" };
    }
  }

  if (bundle.type === "workspace-profile") {
    if (!bundle.workspace) {
      return { ok: false, message: "Workspace profile bundle is missing workspace payload" };
    }
  }

  return { ok: true, bundle };
}

export function getBundleCounts(bundle) {
  const workspaceSkills = maybeArray(bundle.workspace?.skills).map(normalizeSkillItem).filter(Boolean);
  const opencode = maybeObject(bundle.workspace?.opencode);
  const openwork = maybeObject(bundle.workspace?.openwork);
  const commands = maybeArray(bundle.workspace?.commands).map(normalizeCommandItem).filter(Boolean);
  const agentEntries = Object.entries(maybeObject(opencode?.agent) ?? {});
  const mcpEntries = Object.entries(maybeObject(opencode?.mcp) ?? {});

  return {
    skillCount:
      bundle.type === "skill"
        ? bundle.name
          ? 1
          : 0
        : bundle.type === "skills-set"
          ? bundle.skills.length
          : workspaceSkills.length,
    commandCount: commands.length,
    agentCount: agentEntries.length,
    mcpCount: mcpEntries.length,
    hasConfig: Boolean(opencode || openwork),
  };
}

function readVersionFromContent(content) {
  const { data } = parseFrontmatter(content);
  const version = maybeString(data.version).trim();
  return version || "";
}

export function collectBundleItems(bundle, limit = 8) {
  const items = [];

  if (bundle.type === "skill") {
    items.push({
      name: bundle.name || "Untitled skill",
      kind: "Skill",
      meta: bundle.trigger ? `Trigger · ${bundle.trigger}` : readVersionFromContent(bundle.content) || "Skill bundle",
      tone: "skill",
    });
  }

  if (bundle.type === "skills-set") {
    for (const skill of bundle.skills) {
      items.push({
        name: skill.name,
        kind: "Skill",
        meta: skill.trigger ? `Trigger · ${skill.trigger}` : readVersionFromContent(skill.content) || "Skill",
        tone: "skill",
      });
    }
  }

  if (bundle.type === "workspace-profile") {
    const workspaceSkills = maybeArray(bundle.workspace?.skills).map(normalizeSkillItem).filter(Boolean);
    for (const skill of workspaceSkills) {
      items.push({
        name: skill.name,
        kind: "Skill",
        meta: skill.trigger ? `Trigger · ${skill.trigger}` : readVersionFromContent(skill.content) || "Skill",
        tone: "skill",
      });
    }

    const opencode = maybeObject(bundle.workspace?.opencode);
    for (const [name, config] of Object.entries(maybeObject(opencode?.agent) ?? {})) {
      const entry = maybeObject(config) ?? {};
      const version = maybeString(entry.version).trim();
      const model = maybeString(entry.model).trim();
      items.push({
        name,
        kind: "Agent",
        meta: version ? `v${version}` : model ? model : "Agent config",
        tone: "agent",
      });
    }

    for (const [name, config] of Object.entries(maybeObject(opencode?.mcp) ?? {})) {
      const entry = maybeObject(config) ?? {};
      const type = maybeString(entry.type).trim();
      const url = maybeString(entry.url).trim();
      items.push({
        name,
        kind: "MCP",
        meta: type ? `${humanizeType(type)} MCP` : url ? "Remote MCP" : "MCP config",
        tone: "mcp",
      });
    }

    const commands = maybeArray(bundle.workspace?.commands).map(normalizeCommandItem).filter(Boolean);
    for (const command of commands) {
      items.push({
        name: command.name,
        kind: "Command",
        meta: command.agent ? `Agent · ${command.agent}` : "Command",
        tone: "command",
      });
    }
  }

  return items.slice(0, limit);
}

export function prettyJson(rawJson) {
  try {
    return JSON.stringify(JSON.parse(rawJson), null, 2);
  } catch {
    return rawJson;
  }
}

export function buildBundleNarrative(bundle) {
  const counts = getBundleCounts(bundle);
  if (bundle.type === "skill") {
    return "One reusable skill, wrapped in a share link that opens directly into a new OpenWork worker.";
  }
  if (bundle.type === "skills-set") {
    return `${counts.skillCount} skills packaged together so a new worker can start with the full set in one import.`;
  }

  const parts = [];
  if (counts.skillCount) parts.push(`${counts.skillCount} skill${counts.skillCount === 1 ? "" : "s"}`);
  if (counts.agentCount) parts.push(`${counts.agentCount} agent${counts.agentCount === 1 ? "" : "s"}`);
  if (counts.mcpCount) parts.push(`${counts.mcpCount} MCP${counts.mcpCount === 1 ? "" : "s"}`);
  if (counts.commandCount) parts.push(`${counts.commandCount} command${counts.commandCount === 1 ? "" : "s"}`);
  return parts.length
    ? `${parts.join(", ")} bundled into a worker package that imports through OpenWork with one step.`
    : "Worker configuration bundle prepared for OpenWork import.";
}

export function buildStatusMarkup({ title, description, actionHref, actionLabel }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - OpenWork Share</title>
  <style>
    @font-face {
      font-family: "FK Raster Roman Compact Smooth";
      src: url("https://openwork.software/fonts/FKRasterRomanCompact-Smooth.woff2") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    :root {
      color-scheme: light;
      --ow-bg: #f6f9fc;
      --ow-ink: #011627;
      --ow-card: rgba(255, 255, 255, 0.8);
      --ow-border: rgba(255, 255, 255, 0.8);
      --ow-shadow: 0 20px 60px -15px rgba(0, 0, 0, 0.1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: Inter, "Segoe UI", sans-serif;
      color: var(--ow-ink);
      background:
        radial-gradient(circle at top left, rgba(251, 191, 36, 0.34), transparent 36%),
        radial-gradient(circle at right, rgba(96, 165, 250, 0.28), transparent 30%),
        radial-gradient(circle at bottom right, rgba(244, 114, 182, 0.14), transparent 28%),
        linear-gradient(180deg, #fbfdff 0%, var(--ow-bg) 100%);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        radial-gradient(rgba(1, 22, 39, 0.055) 0.75px, transparent 0.75px),
        radial-gradient(rgba(1, 22, 39, 0.03) 0.6px, transparent 0.6px);
      background-position: 0 0, 18px 18px;
      background-size: 36px 36px;
      opacity: 0.34;
      mix-blend-mode: multiply;
    }
    .card {
      position: relative;
      z-index: 1;
      width: min(100%, 540px);
      border-radius: 2rem;
      padding: 32px;
      border: 1px solid var(--ow-border);
      background: var(--ow-card);
      box-shadow: var(--ow-shadow);
      backdrop-filter: blur(16px);
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(2rem, 5vw, 2.8rem);
      line-height: 0.96;
      letter-spacing: -0.06em;
    }
    p {
      margin: 0;
      color: #5f6b7a;
      line-height: 1.6;
    }
    a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 24px;
      min-height: 48px;
      padding: 0 20px;
      border-radius: 999px;
      text-decoration: none;
      color: white;
      background: #011627;
      transition: transform 300ms ${SHARE_EASE}, background-color 300ms ${SHARE_EASE}, box-shadow 300ms ${SHARE_EASE};
      box-shadow: 0 14px 32px -16px rgba(1, 22, 39, 0.55);
      font-weight: 500;
    }
    a:hover {
      background: rgb(110, 110, 110);
      transform: translateY(-1px);
      box-shadow:
        rgba(0, 0, 0, 0.06) 0px 0px 0px 1px,
        rgba(0, 0, 0, 0.04) 0px 1px 2px 0px,
        rgba(0, 0, 0, 0.04) 0px 2px 4px 0px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
    ${actionHref && actionLabel ? `<a href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>` : ""}
  </main>
</body>
</html>`;
}
