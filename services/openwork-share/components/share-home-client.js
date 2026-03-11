"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  getPackageStatus,
  getPreviewItems,
  getShareFeedback,
} from "./share-home-state.js";

// TODO: replace with a proper syntax highlighting library (e.g. shiki or highlight.js)
const SKILL_KEYWORDS = /\b(Identity|Scope|Trigger|Parameters|Default behaviors|When|Why|What|How|Runs|sends|handle|qualify|route|Score|Escalate|Send)\b/g;
const SKILL_TYPES = /\b(Agent|Skill|MCP|Config|Remote|Trigger|OpenWork|OpenCode|Duration|Handlebars)\b/g;
const SKILL_FIELDS = /^(\s*-\s*)([a-z_]+)(:)/gm;

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function span(cls, inner) {
  return `<span class="${cls}">${inner}</span>`;
}

function highlightJsonLine(raw) {
  const tokens = [];
  let i = 0;

  while (i < raw.length) {
    if (raw[i] === '"') {
      const end = raw.indexOf('"', i + 1);
      if (end === -1) break;
      const str = raw.slice(i, end + 1);
      const afterStr = raw.slice(end + 1).trimStart();
      if (afterStr.startsWith(":")) {
        tokens.push(span("hl-key", esc(str)));
      } else if (/^https?:\/\//.test(str.slice(1, -1))) {
        tokens.push(span("hl-url", esc(str)));
      } else {
        tokens.push(span("hl-string", esc(str)));
      }
      i = end + 1;
    } else if (/[{}\[\]]/.test(raw[i])) {
      tokens.push(span("hl-bracket", esc(raw[i])));
      i++;
    } else if (raw[i] === ":" || raw[i] === ",") {
      tokens.push(span("hl-punctuation", esc(raw[i])));
      i++;
    } else if (/\d/.test(raw[i])) {
      const match = raw.slice(i).match(/^\d+(\.\d+)?/);
      if (match) {
        tokens.push(span("hl-number", match[0]));
        i += match[0].length;
      } else {
        tokens.push(esc(raw[i]));
        i++;
      }
    } else if (raw.slice(i).startsWith("true") && !/\w/.test(raw[i + 4] || "")) {
      tokens.push(span("hl-keyword", "true"));
      i += 4;
    } else if (raw.slice(i).startsWith("false") && !/\w/.test(raw[i + 5] || "")) {
      tokens.push(span("hl-keyword", "false"));
      i += 5;
    } else if (raw.slice(i).startsWith("null") && !/\w/.test(raw[i + 4] || "")) {
      tokens.push(span("hl-keyword", "null"));
      i += 4;
    } else if (raw.slice(i).startsWith("//")) {
      tokens.push(span("hl-comment", esc(raw.slice(i))));
      break;
    } else {
      tokens.push(esc(raw[i]));
      i++;
    }
  }

  return tokens.join("");
}

function highlightMdLine(raw) {
  const line = esc(raw);

  if (/^#{1,6}\s/.test(raw)) {
    const match = line.match(/^(#{1,6}\s)(.*)/);
    if (match) return span("hl-punctuation", match[1]) + span("hl-heading", match[2]);
  }

  let result = line;

  result = result.replace(/^(\s*)(- )([a-z_]+)(:\s)/g, (_, ws, bullet, field, sep) =>
    ws + span("hl-punctuation", bullet) + span("hl-field", field) + span("hl-punctuation", sep)
  );
  result = result.replace(/^(\s*)(- )/g, (_, ws, bullet) =>
    ws + span("hl-punctuation", bullet)
  );

  result = result.replace(/(&quot;[^&]*(?:&[^&]*)*?&quot;)/g, span("hl-string", "$1"));
  result = result.replace(/(`[^`]+`)/g, span("hl-inline-code", "$1"));
  result = result.replace(/(\*\*[^*]+\*\*)/g, span("hl-bold", "$1"));

  result = result.replace(SKILL_KEYWORDS, span("hl-keyword", "$1"));
  result = result.replace(SKILL_TYPES, span("hl-type", "$1"));

  result = result.replace(/\b(\d+(?:\.\d+)?(?:h|ms|s|m)?)\b/g, span("hl-number", "$1"));

  result = result.replace(/(\|)/g, span("hl-punctuation", "$1"));

  return result;
}

function highlightSyntax(text) {
  if (!text) return "";
  const trimmed = text.trimStart();
  const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const highlightLine = isJson ? highlightJsonLine : highlightMdLine;
  return text.split("\n").map(highlightLine).join("\n");
}

function toneClass(item) {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  if (item?.tone === "config") return "dot-config";
  return "dot-skill";
}

function buildVirtualEntry(content) {
  const normalized = String(content || "");
  const trimmed = normalized.trimStart();
  const isJsonLike = trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("//") || trimmed.startsWith("/*");

  return {
    name: isJsonLike ? "clipboard.jsonc" : "clipboard.md",
    path: isJsonLike ? "clipboard/clipboard.jsonc" : "clipboard/clipboard.md",
    async text() {
      return normalized;
    }
  };
}

async function fileToPayload(file) {
  return {
    name: file.name,
    path: file.relativePath || file.webkitRelativePath || file.path || file.name,
    content: await file.text()
  };
}

function flattenEntries(entry, prefix = "") {
  return new Promise((resolve, reject) => {
    if (entry?.isFile) {
      entry.file(
        (file) => {
          file.relativePath = `${prefix}${file.name}`;
          resolve([file]);
        },
        reject
      );
      return;
    }

    if (!entry?.isDirectory) {
      resolve([]);
      return;
    }

    const reader = entry.createReader();
    const files = [];

    const readBatch = () => {
      reader.readEntries(
        async (entries) => {
          if (!entries.length) {
            resolve(files);
            return;
          }
          for (const child of entries) {
            files.push(...(await flattenEntries(child, `${prefix}${entry.name}/`)));
          }
          readBatch();
        },
        reject
      );
    };

    readBatch();
  });
}

async function collectDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  if (!items.length) return Array.from(dataTransfer?.files || []);
  const collected = [];

  for (const item of items) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (!entry) {
      const file = item.getAsFile ? item.getAsFile() : null;
      if (file) collected.push(file);
      continue;
    }
    collected.push(...(await flattenEntries(entry)));
  }

  return collected;
}

export default function ShareHomeClient() {
  const [selectedEntries, setSelectedEntries] = useState([]);
  const [pasteValue, setPasteValue] = useState("");
  const [preview, setPreview] = useState(null);
  const [generatedUrl, setGeneratedUrl] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [statusText, setStatusText] = useState("Nothing selected yet.");
  const [busyMode, setBusyMode] = useState(null);
  const [dropActive, setDropActive] = useState(false);
  const [copyState, setCopyState] = useState("ready-not-copied");
  const [pasteState, setPasteState] = useState("Paste markdown or JSON/JSONC config text and we will package it like a dropped file.");
  const [activeExample, setActiveExample] = useState(null);
  const requestIdRef = useRef(0);

  const trimmedPaste = useMemo(() => pasteValue.trim(), [pasteValue]);
  const hasPastedSkill = trimmedPaste.length > 0;
  const busy = busyMode !== null;
  const effectiveEntries = useMemo(
    () => (selectedEntries.length ? selectedEntries : hasPastedSkill ? [buildVirtualEntry(trimmedPaste)] : []),
    [selectedEntries, hasPastedSkill, trimmedPaste]
  );

  const pasteCountLabel = `${trimmedPaste.length} ${trimmedPaste.length === 1 ? "character" : "characters"}`;
  const highlightedPaste = useMemo(() => highlightSyntax(pasteValue), [pasteValue]);
  const visibleItems = useMemo(
    () => activeExample ? getPreviewItems(null) : getPreviewItems(preview),
    [preview, activeExample]
  );
  const hasRealFiles = !activeExample && Boolean(preview?.items?.length);
  const packageStatus = useMemo(
    () => getPackageStatus({ generatedUrl, warnings, preview, effectiveEntryCount: effectiveEntries.length, busy }),
    [generatedUrl, warnings, preview, effectiveEntries.length, busy]
  );
  const shareFeedback = useMemo(() => getShareFeedback(copyState), [copyState]);
  const selectionLabel = effectiveEntries.length
    ? `${effectiveEntries.length} ${effectiveEntries.length === 1 ? "entry" : "entries"} ready`
    : null;

  const requestPackage = async (previewOnly) => {
    const files = await Promise.all(effectiveEntries.map(fileToPayload));
    const response = await fetch("/v1/package", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ files, preview: previewOnly })
    });

    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok) {
      throw new Error(json?.message || "Packaging failed.");
    }

    return json;
  };

  useEffect(() => {
    if (!effectiveEntries.length) {
      requestIdRef.current += 1;
      setPreview(null);
      setGeneratedUrl("");
      setWarnings([]);
      setBusyMode(null);
      setCopyState("ready-not-copied");
      setStatusText("Nothing selected yet.");
      return;
    }

    const currentRequestId = requestIdRef.current + 1;
    requestIdRef.current = currentRequestId;
    let cancelled = false;

    setBusyMode("preview");
    setStatusText("Reading files...");

    void (async () => {
      try {
        const nextPreview = await requestPackage(true);
        if (cancelled || requestIdRef.current !== currentRequestId) return;
        setPreview(nextPreview);
        setStatusText("Preview ready. Click Generate to publish.");
      } catch (error) {
        if (cancelled || requestIdRef.current !== currentRequestId) return;
        setPreview(null);
        setStatusText(error instanceof Error ? error.message : "Preview failed.");
      } finally {
        if (!cancelled && requestIdRef.current === currentRequestId) {
          setBusyMode(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveEntries]);

  const assignEntries = async (files) => {
    const entries = Array.from(files || []).filter(Boolean);
    setSelectedEntries(entries);
    setPreview(null);
    setGeneratedUrl("");
    setWarnings([]);
    setCopyState("ready-not-copied");
    setActiveExample(null);

    if (entries.length) {
      try {
        const texts = await Promise.all(entries.slice(0, 4).map((f) => f.text()));
        const combined = entries.length === 1
          ? texts[0]
          : texts.map((t, i) => `// --- ${entries[i].name} ---\n${t}`).join("\n\n");
        setPasteValue(combined);
        setPasteState(`Showing ${entries.length === 1 ? entries[0].name : `${entries.length} files`}. Edit below or generate a share link.`);
      } catch {
        setPasteValue("");
        setPasteState("Could not read file contents for preview.");
      }
    } else {
      setPasteValue("");
      setPasteState("Paste markdown or JSON/JSONC config text and we will package it like a dropped file.");
    }
  };

  const handlePasteChange = (event) => {
    setPasteValue(event.target.value);
    setSelectedEntries([]);
    setPreview(null);
    setGeneratedUrl("");
    setWarnings([]);
    setCopyState("ready-not-copied");
    setActiveExample(null);
    setPasteState(
      event.target.value.trim()
        ? "Preview the pasted content, then generate a share link."
        : "Paste markdown or JSON/JSONC config text and we will package it like a dropped file."
    );
  };

  const pasteFromClipboard = async () => {
    if (!navigator.clipboard?.readText) {
      setPasteState("Clipboard access is not available in this browser.");
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setPasteState("Clipboard is empty.");
        return;
      }
      setPasteValue(text);
      setSelectedEntries([]);
      setPreview(null);
      setGeneratedUrl("");
      setWarnings([]);
      setCopyState("ready-not-copied");
      setActiveExample(null);
      setPasteState("Clipboard pasted. Preview is ready.");
    } catch {
      setPasteState("Clipboard access was blocked. Paste manually into the field.");
    }
  };

  const publishBundle = async () => {
    if (!effectiveEntries.length || busy) return;

    setBusyMode("publish");
    setStatusText("Publishing...");

    try {
      const result = await requestPackage(false);
      const nextUrl = typeof result?.url === "string" ? result.url : "";
      let nextCopyState = "ready-not-copied";

      if (nextUrl) {
        try {
          await navigator.clipboard.writeText(nextUrl);
          nextCopyState = "copied";
        } catch {
          nextCopyState = "copy-failed";
        }
      }

      setPreview(result);
      setWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      setGeneratedUrl(nextUrl);
      setCopyState(nextCopyState);
      setStatusText("Package published successfully!");
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "Publishing failed.");
    } finally {
      setBusyMode(null);
    }
  };

  const copyGeneratedUrl = async () => {
    if (!generatedUrl) return;

    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopyState("copied");
    } catch {
      setCopyState("copy-failed");
    }
  };

  return (
    <section className="hero-layout hero-layout-share">
        <div className="hero-copy">
          <h1>
            Share your <em>agent</em>
            <br />
            setup
          </h1>
          <p className="hero-body">
            Package agents, skills, commands, and config files in seconds.
          </p>
          <p className="hero-note">Secret-looking values stay out. Shareable config is checked before publish.</p>
        </div>

        <div className="share-cards-grid">
          <div className="package-card share-card surface-soft">
            <div className="package-card-header">
              <span className="surface-chip">Package once</span>
              {selectionLabel && <div className="selection-badge">{selectionLabel}</div>}
            </div>

            <h2 className="simple-app-title">Create a share link</h2>
            <p className="simple-app-copy">
              Drop <span className="inline-token token-agent">AGENTS.md</span>,{" "}
              <span className="inline-token token-skill">SKILL.md</span>,{" "}
              <span className="inline-token token-mcp">mcp.json</span>, or{" "}
              <span className="inline-token token-config">config</span> files, preview and share them with others.
            </p>

            <div className="input-method-grid">
              <label
                className={`drop-zone${dropActive ? " is-dragover" : ""}`}
                aria-busy={busy ? "true" : "false"}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDropActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setDropActive(false);
                }}
                onDrop={async (event) => {
                  event.preventDefault();
                  setDropActive(false);
                  if (busy) return;
                  const files = await collectDroppedFiles(event.dataTransfer);
                  assignEntries(files);
                }}
              >
                <input
                  className="visually-hidden"
                  type="file"
                  multiple
                  onChange={(event) => assignEntries(event.target.files)}
                />
                <div className="drop-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                </div>
                <div className="drop-text">
                  <h3>Drop files</h3>
                  <p>Browse local files</p>
                </div>
              </label>

              <div className="included-section">
                <h4>{hasRealFiles ? "Files" : "Example contents"}</h4>
                <div className="included-list">
                  {visibleItems.map((item) => {
                    const isExample = Boolean(item.example);
                    const isActive = activeExample === item.name;
                    const isDimmed = isExample && activeExample && !isActive;
                    return (
                      <button
                        type="button"
                        className={`included-item${isActive ? " is-active" : ""}${isDimmed ? " is-dimmed" : ""}`}
                        key={`${item.kind}-${item.name}`}
                        disabled={!isExample}
                        onClick={() => {
                          if (!isExample) return;
                          setActiveExample(isActive ? null : item.name);
                          setPasteValue(isActive ? "" : item.example);
                          setSelectedEntries([]);
                          setGeneratedUrl("");
                          setWarnings([]);
                          setCopyState("ready-not-copied");
                          setPasteState(
                            isActive
                              ? "Paste markdown or JSON/JSONC config text and we will package it like a dropped file."
                              : `Loaded "${item.name}" example. Preview is ready.`
                          );
                        }}
                      >
                        <div className={`item-dot ${toneClass(item)}`}></div>
                        <div className="item-text">
                          <span className="item-title">{item.name || "Unnamed item"}</span>
                          <span className="item-meta">{item.meta || item.kind || "Item"}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

          </div>

          <aside className="preview-panel carbon-preview">
            <div className="carbon-window">
              <div className="carbon-titlebar">
                <div className="carbon-dots">
                  <span className="carbon-dot dot-close"></span>
                  <span className="carbon-dot dot-minimize"></span>
                  <span className="carbon-dot dot-expand"></span>
                </div>
                <span className="carbon-filename">
                  {selectedEntries.length === 1
                    ? selectedEntries[0].name
                    : selectedEntries.length > 1
                      ? `${selectedEntries.length} files`
                      : pasteValue.trim()
                        ? (pasteValue.trimStart().startsWith("{") || pasteValue.trimStart().startsWith("[") ? "clipboard.jsonc" : "clipboard.md")
                        : "untitled"}
                </span>
              </div>
              <div className="carbon-editor-wrap">
                <pre
                  className="carbon-highlight"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: highlightedPaste + "\n" }}
                />
                <textarea
                  className="carbon-editor"
                  value={pasteValue}
                  onChange={handlePasteChange}
                  placeholder="Paste AGENTS.md, SKILL.md, command markdown, or JSON/JSONC config content here."
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="paste-meta">
              <span>{pasteState}</span>
              <span>{pasteCountLabel}</span>
            </div>
          </aside>

          <div className="share-actions-bar share-card-full" aria-live="polite">
            <div className={`package-status severity-${packageStatus.severity}`}>
              <span className="package-status-dot"></span>
              <span className="package-status-label">{packageStatus.label}</span>
            </div>

            {packageStatus.items.length > 0 && (
              <ul className="package-status-items">
                {packageStatus.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}

            {generatedUrl ? (
              <>
                <div className="share-link-inline mono">{generatedUrl}</div>
                <div className="share-link-bar-actions">
                  <a className="button-primary" href={generatedUrl} target="_blank" rel="noreferrer">
                    Open share page
                  </a>
                  <button className="button-secondary" type="button" onClick={copyGeneratedUrl}>
                    {shareFeedback.copyLabel}
                  </button>
                  <span className={`share-feedback-inline${shareFeedback.isSuccess ? " is-success" : ""}`}>
                    {shareFeedback.badge}
                  </span>
                </div>
              </>
            ) : (
              <button
                className="button-primary"
                type="button"
                onClick={() => void publishBundle()}
                disabled={busy || !effectiveEntries.length || !preview}
              >
                {busyMode === "publish" ? "Publishing..." : "Generate share link"}
              </button>
            )}
          </div>
        </div>
    </section>
  );
}
