import { parse as parseJsonc } from "jsonc-parser";

import { humanizeType, parseFrontmatter } from "./share-utils.js";

const MAX_FILES = 200;
const SECRET_KEY_RE = /(token|secret|password|api[-_]?key|authorization|bearer|private[-_]?key|client[-_]?secret)/i;
const SAFE_SECRET_VALUE_RE = /^(\$\{|\{env:|env\.|process\.env\.|<|YOUR_|REPLACE_ME|example|changeme)/i;
const AGENT_FRONTMATTER_KEYS = new Set(["mode", "model", "tools", "permission", "temperature", "color", "prompt"]);

function normalizePath(input) {
  return String(input ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

function basename(path) {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  return normalized.split("/").pop() ?? normalized;
}

function dirname(path) {
  const normalized = normalizePath(path);
  if (!normalized || !normalized.includes("/")) return "";
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function stem(path) {
  const name = basename(path);
  return name.replace(/\.[^.]+$/, "");
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeFile(input, index) {
  const path = normalizePath(input.path || input.webkitRelativePath || input.name || `file-${index + 1}`);
  const name = basename(path) || `file-${index + 1}`;
  const content = String(input.content ?? "").replace(/^\uFEFF/, "");
  return { path, name, content };
}

function isMarkdownFile(file) {
  return /\.md$/i.test(file.name);
}

function isJsonFile(file) {
  return /\.jsonc?$/i.test(file.name);
}

function isSkillFile(file) {
  const lowerPath = file.path.toLowerCase();
  return basename(lowerPath) === "skill.md" || /(^|\/)\.opencode\/skills\//.test(lowerPath) || /(^|\/)skills\//.test(lowerPath);
}

function isCommandFile(file) {
  return /(^|\/)\.opencode\/commands\//.test(file.path.toLowerCase()) || /(^|\/)commands\//.test(file.path.toLowerCase());
}

function isAgentFile(file, frontmatterData) {
  const lowerPath = file.path.toLowerCase();
  if (/(^|\/)\.opencode\/agents\//.test(lowerPath) || /(^|\/)agents\//.test(lowerPath)) {
    return true;
  }
  return Object.keys(frontmatterData).some((key) => AGENT_FRONTMATTER_KEYS.has(key));
}

function isOpenworkConfigFile(file) {
  return /(^|\/)openwork\.json$/i.test(file.path);
}

function isOpencodeConfigFile(file) {
  return /(^|\/)opencode\.jsonc?$/i.test(file.path);
}

function looksLikeNamedMcpFile(file) {
  return /(^|\/)mcp\//i.test(file.path) || /\.mcp\.jsonc?$/i.test(file.name);
}

function looksLikeNamedAgentJsonFile(file) {
  return /(^|\/)agents\//i.test(file.path) || /\.agent\.jsonc?$/i.test(file.name);
}

function resolveName(preferred, fallback) {
  const fromPreferred = slugify(preferred);
  if (fromPreferred) return fromPreferred;
  const fromFallback = slugify(fallback);
  if (fromFallback) return fromFallback;
  return `item-${Date.now()}`;
}

function buildPreviewItem(name, kind, meta, tone) {
  return { name, kind, meta, tone };
}

function buildSkillRecord(file, warnings) {
  const { data } = parseFrontmatter(file.content);
  const parentName = basename(dirname(file.path));
  const name = resolveName(data.name, parentName || stem(file.path));
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const trigger = typeof data.trigger === "string" ? data.trigger.trim() : "";
  const version = typeof data.version === "string" ? data.version.trim() : "";
  if (!file.content.trim()) {
    warnings.push(`Ignored empty skill file: ${file.path}`);
    return null;
  }
  return {
    name,
    description,
    trigger,
    content: file.content,
    preview: buildPreviewItem(name, "Skill", version ? `v${version}` : trigger ? `Trigger · ${trigger}` : "Skill", "skill"),
  };
}

function buildAgentRecord(file, warnings) {
  const { data, body } = parseFrontmatter(file.content);
  const name = resolveName(data.name, stem(file.path));
  if (!name) {
    warnings.push(`Ignored agent without a valid name: ${file.path}`);
    return null;
  }

  const config = { ...data };
  delete config.name;
  const promptBody = body.trim();
  if (promptBody && typeof config.prompt !== "string") {
    config.prompt = promptBody;
  }

  const version = typeof config.version === "string" ? config.version.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";

  return {
    name,
    config,
    preview: buildPreviewItem(name, "Agent", version ? `v${version}` : model || "Agent config", "agent"),
  };
}

function buildCommandRecord(file, warnings) {
  const { data, body } = parseFrontmatter(file.content);
  const name = resolveName(data.name, stem(file.path));
  const template = body.trim();
  if (!name || !template) {
    warnings.push(`Ignored command without template: ${file.path}`);
    return null;
  }

  return {
    name,
    description: typeof data.description === "string" ? data.description.trim() : "",
    template,
    agent: typeof data.agent === "string" ? data.agent.trim() : "",
    model: typeof data.model === "string" ? data.model.trim() : "",
    subtask: data.subtask === true,
    preview: buildPreviewItem(name, "Command", data.agent ? `Agent · ${data.agent}` : "Command", "command"),
  };
}

function parseJsonConfig(file) {
  try {
    return parseJsonc(file.content);
  } catch (error) {
    throw new Error(`Could not parse ${file.path} as JSON/JSONC`);
  }
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectSecretPaths(value, prefix = []) {
  const hits = [];
  if (!value || typeof value !== "object") return hits;

  for (const [key, child] of Object.entries(value)) {
    const nextPrefix = [...prefix, key];
    if (SECRET_KEY_RE.test(key) && typeof child === "string" && child.trim() && !SAFE_SECRET_VALUE_RE.test(child.trim())) {
      hits.push(nextPrefix.join("."));
    }
    if (typeof child === "object") {
      hits.push(...collectSecretPaths(child, nextPrefix));
    }
  }

  return hits;
}

function readConfigSection(file, warnings) {
  const parsed = parseJsonConfig(file);
  if (!isRecord(parsed)) {
    throw new Error(`Expected ${file.path} to contain an object`);
  }

  const opencode = {};
  let openwork = null;
  const preview = [];

  if (isOpenworkConfigFile(file)) {
    openwork = cloneRecord(parsed);
  }

  if (isOpencodeConfigFile(file)) {
    if (isRecord(parsed.mcp) && Object.keys(parsed.mcp).length) {
      opencode.mcp = cloneRecord(parsed.mcp);
      for (const [name, entry] of Object.entries(parsed.mcp)) {
        const meta = isRecord(entry) && typeof entry.type === "string" ? `${humanizeType(entry.type)} MCP` : "MCP config";
        preview.push(buildPreviewItem(name, "MCP", meta, "mcp"));
      }
    }
    if (isRecord(parsed.agent) && Object.keys(parsed.agent).length) {
      opencode.agent = cloneRecord(parsed.agent);
      for (const [name, entry] of Object.entries(parsed.agent)) {
        const meta = isRecord(entry) && typeof entry.model === "string" ? entry.model : "Agent config";
        preview.push(buildPreviewItem(name, "Agent", meta, "agent"));
      }
    }
  }

  if (!Object.keys(opencode).length && !openwork) {
    if (looksLikeNamedMcpFile(file)) {
      const name = resolveName("", stem(file.path));
      opencode.mcp = { [name]: cloneRecord(parsed) };
      const meta = typeof parsed.type === "string" ? `${humanizeType(parsed.type)} MCP` : "MCP config";
      preview.push(buildPreviewItem(name, "MCP", meta, "mcp"));
    } else if (looksLikeNamedAgentJsonFile(file)) {
      const name = resolveName(parsed.name, stem(file.path));
      opencode.agent = { [name]: cloneRecord(parsed) };
      const meta = typeof parsed.model === "string" ? parsed.model : "Agent config";
      preview.push(buildPreviewItem(name, "Agent", meta, "agent"));
    }
  }

  const secretHits = [
    ...collectSecretPaths(opencode.mcp ?? {}, ["opencode", "mcp"]),
    ...collectSecretPaths(opencode.agent ?? {}, ["opencode", "agent"]),
    ...collectSecretPaths(openwork ?? {}, ["openwork"]),
  ];

  if (secretHits.length) {
    throw new Error(`Potential secrets found in ${file.path}: ${secretHits.slice(0, 5).join(", ")}`);
  }

  if (!Object.keys(opencode).length && !openwork) {
    warnings.push(`Ignored unsupported config file: ${file.path}`);
    return null;
  }

  return { opencode, openwork, preview };
}

function mergeNamedObjects(target, source) {
  for (const [name, value] of Object.entries(source ?? {})) {
    target[name] = value;
  }
}

function buildSummary(skills, agents, mcp, commands, warnings) {
  return {
    skills: skills.length,
    agents: Object.keys(agents).length,
    mcpServers: Object.keys(mcp).length,
    commands: commands.length,
    warnings: warnings.length,
  };
}

function buildBundleName(inputName, skills, agentCount, mcpCount, commandCount) {
  const explicit = String(inputName ?? "").trim();
  if (explicit) return explicit;
  if (skills.length === 1 && !agentCount && !mcpCount && !commandCount) return skills[0].name;
  if (skills.length > 1 && !agentCount && !mcpCount && !commandCount) return "Shared skills set";
  if (skills.length === 1) return `${skills[0].name} worker package`;
  return "Packaged worker";
}

function buildBundleDescription(bundleType, summary) {
  if (bundleType === "skill") return "Single skill bundle generated from dropped OpenWork files.";
  if (bundleType === "skills-set") return `${summary.skills} skills packaged together.`;
  const parts = [];
  if (summary.skills) parts.push(`${summary.skills} skill${summary.skills === 1 ? "" : "s"}`);
  if (summary.agents) parts.push(`${summary.agents} agent${summary.agents === 1 ? "" : "s"}`);
  if (summary.mcpServers) parts.push(`${summary.mcpServers} MCP${summary.mcpServers === 1 ? "" : "s"}`);
  if (summary.commands) parts.push(`${summary.commands} command${summary.commands === 1 ? "" : "s"}`);
  return parts.length ? `${parts.join(", ")} bundled into a worker package.` : "Worker package generated from OpenWork files.";
}

export function packageOpenworkFiles(input) {
  const rawFiles = Array.isArray(input?.files) ? input.files : [];
  if (!rawFiles.length) {
    throw new Error("Drop one or more OpenWork files to package them.");
  }
  if (rawFiles.length > MAX_FILES) {
    throw new Error(`Too many files. Package up to ${MAX_FILES} files at once.`);
  }

  const warnings = [];
  const skills = [];
  const commands = [];
  const previewItems = [];
  const opencodeAgent = {};
  const opencodeMcp = {};
  let openwork = null;

  for (let index = 0; index < rawFiles.length; index += 1) {
    const file = normalizeFile(rawFiles[index], index);
    if (!file.content.trim()) {
      warnings.push(`Ignored empty file: ${file.path}`);
      continue;
    }

    if (isMarkdownFile(file)) {
      if (isSkillFile(file)) {
        const record = buildSkillRecord(file, warnings);
        if (record) {
          skills.push(record);
          previewItems.push(record.preview);
        }
        continue;
      }

      const frontmatter = parseFrontmatter(file.content);
      if (isAgentFile(file, frontmatter.data)) {
        const record = buildAgentRecord(file, warnings);
        if (record) {
          opencodeAgent[record.name] = record.config;
          previewItems.push(record.preview);
        }
        continue;
      }

      if (isCommandFile(file)) {
        const record = buildCommandRecord(file, warnings);
        if (record) {
          commands.push(record);
          previewItems.push(record.preview);
        }
        continue;
      }

      warnings.push(`Ignored unsupported markdown file: ${file.path}`);
      continue;
    }

    if (isJsonFile(file)) {
      const record = readConfigSection(file, warnings);
      if (!record) continue;
      mergeNamedObjects(opencodeAgent, record.opencode?.agent ?? {});
      mergeNamedObjects(opencodeMcp, record.opencode?.mcp ?? {});
      if (record.openwork) openwork = record.openwork;
      previewItems.push(...record.preview);
      continue;
    }

    warnings.push(`Ignored unsupported file type: ${file.path}`);
  }

  const cleanSkills = skills.map(({ preview, ...skill }) => skill);
  const cleanCommands = commands.map(({ preview, ...command }) => command);

  const summary = buildSummary(cleanSkills, opencodeAgent, opencodeMcp, cleanCommands, warnings);
  if (!summary.skills && !summary.agents && !summary.mcpServers && !summary.commands && !openwork) {
    throw new Error("No supported OpenWork files found. Drop skill markdown, agent markdown, command markdown, or OpenCode/OpenWork config files.");
  }

  const hasWorkspaceConfig = Boolean(openwork) || Object.keys(opencodeAgent).length || Object.keys(opencodeMcp).length || cleanCommands.length;
  const name = buildBundleName(input?.bundleName, cleanSkills, summary.agents, summary.mcpServers, summary.commands);

  let bundleType = "workspace-profile";
  let bundle;
  if (cleanSkills.length === 1 && !hasWorkspaceConfig) {
    bundleType = "skill";
    const skill = cleanSkills[0];
    bundle = {
      schemaVersion: 1,
      type: "skill",
      name: skill.name,
      description: skill.description || undefined,
      trigger: skill.trigger || undefined,
      content: skill.content,
    };
  } else if (cleanSkills.length > 0 && !hasWorkspaceConfig) {
    bundleType = "skills-set";
    bundle = {
      schemaVersion: 1,
      type: "skills-set",
      name,
      description: buildBundleDescription("skills-set", summary),
      skills: cleanSkills,
    };
  } else {
    const workspace = {
      workspaceId: "share-service-package",
      exportedAt: Date.now(),
      ...(cleanSkills.length ? { skills: cleanSkills } : null),
      ...(cleanCommands.length ? { commands: cleanCommands } : null),
      ...(openwork ? { openwork } : null),
      ...((Object.keys(opencodeAgent).length || Object.keys(opencodeMcp).length)
        ? {
            opencode: {
              ...(Object.keys(opencodeAgent).length ? { agent: opencodeAgent } : null),
              ...(Object.keys(opencodeMcp).length ? { mcp: opencodeMcp } : null),
            },
          }
        : null),
    };

    bundle = {
      schemaVersion: 1,
      type: "workspace-profile",
      name,
      description: buildBundleDescription("workspace-profile", summary),
      workspace,
    };
  }

  return {
    bundle,
    bundleType,
    name: bundle.name,
    summary,
    warnings,
    items: previewItems.slice(0, 12),
  };
}
