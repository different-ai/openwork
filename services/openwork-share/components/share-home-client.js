"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_PREVIEW_ITEMS = [
  { name: "Sales Inbound", kind: "Agent", meta: "Agent · v1.2.0", tone: "agent" },
  { name: "follow-up-reminder", kind: "Skill", meta: "Skill · Trigger", tone: "skill" },
  { name: "crm-sync", kind: "MCP", meta: "MCP · Remote", tone: "mcp" }
];

const WORKFLOW_STEPS = [
  "Drop a worker folder, a few OpenWork files, or one SKILL.md paste.",
  "Preview the inferred package before anything gets published.",
  "Generate one import link that opens directly inside OpenWork."
];

const SAFETY_POINTS = [
  "Shareable config only. Secret-looking values are rejected before publish.",
  "Human page and machine payload stay side by side for import flows.",
  "The bundle keeps the landing page's glass shell but stays operational and readable."
];

function toneClass(item) {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  return "dot-skill";
}

function buildVirtualEntry(content) {
  return {
    name: "SKILL.md",
    path: ".opencode/skills/pasted-skill/SKILL.md",
    async text() {
      return String(content || "");
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
  const [copyState, setCopyState] = useState("Copy link");
  const [pasteState, setPasteState] = useState("Paste one skill and we will package it like a dropped file.");
  const requestIdRef = useRef(0);

  const hasPastedSkill = pasteValue.trim().length > 0;
  const busy = busyMode !== null;
  const effectiveEntries = useMemo(
    () => (selectedEntries.length ? selectedEntries : hasPastedSkill ? [buildVirtualEntry(pasteValue.trim())] : []),
    [selectedEntries, hasPastedSkill, pasteValue]
  );

  const pasteCountLabel = `${pasteValue.trim().length} ${pasteValue.trim().length === 1 ? "character" : "characters"}`;
  const visibleItems = useMemo(() => {
    const items = Array.isArray(preview?.items) && preview.items.length ? preview.items : DEFAULT_PREVIEW_ITEMS;
    return items.slice(0, 4);
  }, [preview]);
  const summaryCards = useMemo(
    () => [
      { label: "Skills", value: preview?.summary?.skills ?? 1 },
      { label: "Agents", value: preview?.summary?.agents ?? 1 },
      { label: "MCPs", value: preview?.summary?.mcpServers ?? 1 },
      { label: "Commands", value: preview?.summary?.commands ?? 0 }
    ],
    [preview]
  );
  const selectionLabel = effectiveEntries.length
    ? `${effectiveEntries.length} ${effectiveEntries.length === 1 ? "entry" : "entries"} ready`
    : "Drop files or paste a skill";

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
    setCopyState("Copy link");
  };

  const handlePasteChange = (event) => {
    setPasteValue(event.target.value);
    setSelectedEntries([]);
    setGeneratedUrl("");
    setWarnings([]);
    setCopyState("Copy link");
    setPasteState(
      event.target.value.trim()
        ? "Generate a link to preview and publish the pasted skill."
        : "Paste one skill and we will package it like a dropped file."
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
      setCopyState("Copy link");
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
      setPreview(result);
      setWarnings(Array.isArray(result?.warnings) ? result.warnings : []);
      setGeneratedUrl(typeof result?.url === "string" ? result.url : "");
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
      setCopyState("Copied!");
      window.setTimeout(() => setCopyState("Copy link"), 2000);
    } catch {
      setCopyState("Copy failed");
      window.setTimeout(() => setCopyState("Copy link"), 2000);
    }
  };

  return (
    <>
      <section className="hero-layout hero-layout-share">
        <div className="hero-copy">
          <h1>
            Share your <em>agent</em>
            <br />
            setup
          </h1>
          <p className="hero-body">
            Package skills, agents, commands, and MCP config in seconds.
          </p>
          <p className="hero-note">Secrets stay out. The packager rejects configs that look unsafe to publish.</p>
        </div>

        <div className="hero-artifact hero-artifact-share">
          <div className="artifact-window-body">
            <div className="artifact-grid">
              <div className="package-card surface-soft">
                <div className="package-card-header">
                  <div>
                    <span className="surface-chip">Package once</span>
                    <h2 className="simple-app-title">Create a share link</h2>
                    <p className="simple-app-copy">
                      Drop OpenWork files, preview the inferred bundle, then publish a public import page.
                    </p>
                  </div>
                  <div className="selection-badge">{selectionLabel}</div>
                </div>

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
                    <h3>Drop OpenWork files here</h3>
                    <p>or click to browse local files</p>
                  </div>
                </label>

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

                <div className="paste-panel">
                  <textarea
                    value={pasteValue}
                    onChange={handlePasteChange}
                    placeholder="Paste a full SKILL.md file here, including frontmatter and markdown instructions."
                  />
                  <div className="paste-meta">
                    <span>{pasteState}</span>
                    <span>{pasteCountLabel}</span>
                  </div>
                  <div className="paste-actions">
                    <button className="button-secondary" type="button" onClick={pasteFromClipboard}>
                      Paste from clipboard
                    </button>
                  </div>
                </div>

                <div className="package-actions">
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
                </div>
              </div>

            </div>
          </div>
        </div>

      </section>

      {generatedUrl ? (
        <section className="results-grid">
          <div className="result-card">
            <h3>Share link ready</h3>
            <p>Your worker package is published. Anyone with this link can import it directly into OpenWork.</p>
            <div className="url-box">{generatedUrl}</div>
            <div className="button-row">
              <a className="button-primary" href={generatedUrl} target="_blank" rel="noreferrer">
                Open share page
              </a>
              <button className="button-secondary" type="button" onClick={copyGeneratedUrl}>
                {copyState}
              </button>
            </div>
          </div>
          <div className="result-card">
            <h3>Warnings</h3>
            <p>Review any files that were skipped.</p>
            <ul className="warnings-list">
              {warnings.length ? (
                warnings.map((warning) => <li key={warning}>{warning}</li>)
              ) : (
                <li className="warnings-empty">No warnings. Package is clean.</li>
              )}
            </ul>
          </div>
        </section>
      ) : null}
    </>
  );
}
