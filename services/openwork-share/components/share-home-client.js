"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  getPreviewItems,
  getPublishWarnings,
  getPublishedWarnings,
  getShareFeedback,
} from "./share-home-state.js";

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
  const requestIdRef = useRef(0);

  const trimmedPaste = useMemo(() => pasteValue.trim(), [pasteValue]);
  const hasPastedSkill = trimmedPaste.length > 0;
  const busy = busyMode !== null;
  const effectiveEntries = useMemo(
    () => (selectedEntries.length ? selectedEntries : hasPastedSkill ? [buildVirtualEntry(trimmedPaste)] : []),
    [selectedEntries, hasPastedSkill, trimmedPaste]
  );

  const pasteCountLabel = `${trimmedPaste.length} ${trimmedPaste.length === 1 ? "character" : "characters"}`;
  const visibleItems = useMemo(() => getPreviewItems(preview), [preview]);
  const publishWarnings = useMemo(() => getPublishWarnings({ generatedUrl, warnings }), [generatedUrl, warnings]);
  const publishedWarnings = useMemo(() => getPublishedWarnings({ generatedUrl, warnings }), [generatedUrl, warnings]);
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

  const assignEntries = (files) => {
    setSelectedEntries(Array.from(files || []).filter(Boolean));
    setGeneratedUrl("");
    setWarnings([]);
    setCopyState("ready-not-copied");
  };

  const handlePasteChange = (event) => {
    setPasteValue(event.target.value);
    setSelectedEntries([]);
    setGeneratedUrl("");
    setWarnings([]);
    setCopyState("ready-not-copied");
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
      setGeneratedUrl("");
      setWarnings([]);
      setCopyState("ready-not-copied");
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
              <span className="inline-token token-config">config</span> files, preview the inferred bundle, then publish a public import page.
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
            </div>

            {effectiveEntries.length ? (
              <div className="selection-list">
                {effectiveEntries.slice(0, 4).map((entry) => (
                  <div className="selection-item" key={entry.path || entry.name}>
                    <span className="selection-item-name">{entry.name || entry.path}</span>
                    <span className="selection-item-path mono">{entry.path || entry.name}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="included-section">
              <h4>{preview?.items?.length ? "Included" : "Example contents"}</h4>
              <div className="included-list">
                {visibleItems.map((item) => (
                  <div className="included-item" key={`${item.kind}-${item.name}`}>
                    <div className="item-left">
                      <div className={`item-dot ${toneClass(item)}`}></div>
                      <div>
                        <div className="item-title">{item.name || "Unnamed item"}</div>
                        <div className="item-meta">{item.meta || item.kind || "Item"}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <aside className="preview-panel share-card surface-shell">
            <div className="paste-panel">
              <textarea
                value={pasteValue}
                onChange={handlePasteChange}
                placeholder="Paste AGENTS.md, SKILL.md, command markdown, or JSON/JSONC config content here."
              />
              <div className="paste-meta">
                <span>{pasteState}</span>
                <span>{pasteCountLabel}</span>
              </div>
            </div>
          </aside>

          <div className="share-actions-bar share-card-full" aria-live="polite">
            {generatedUrl ? (
              <>
                {publishedWarnings ? (
                  <div className="publish-warning-card">
                    <h4>{publishedWarnings.title}</h4>
                    <p>{publishedWarnings.copy}</p>
                    <ul className="warnings-list warnings-list-inline">
                      {publishedWarnings.items.map((item) => (
                        <li key={item.text} className={item.empty ? "warnings-empty" : ""}>
                          {item.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
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
              <>
                {publishWarnings ? (
                  <div className="publish-warning-card">
                    <h4>{publishWarnings.title}</h4>
                    <p>{publishWarnings.copy}</p>
                    <ul className="warnings-list warnings-list-inline">
                      {publishWarnings.items.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <button
                  className="button-primary"
                  type="button"
                  onClick={() => void publishBundle()}
                  disabled={busy || !effectiveEntries.length || !preview}
                >
                  {busyMode === "publish" ? "Publishing..." : "Generate share link"}
                </button>
                <div className="status-area" data-busy={busy ? "true" : "false"}>
                  <span>{statusText}</span>
                </div>
                <div className="preview-note">
                  Generate a share link to open this bundle in OpenWork or hand it directly to a teammate.
                </div>
              </>
            )}
          </div>
        </div>
    </section>
  );
}
