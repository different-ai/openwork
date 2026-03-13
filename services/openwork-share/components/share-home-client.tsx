"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { BusyMode, CopyState, EntryLike, FilePayload, PackageResponse, PreviewItem } from "./share-home-types";
import { highlightSyntax } from "./share-preview-syntax";
import {
  getPackageStatus,
  getPreviewFilename,
  getPreviewItems,
  getSelectionLabel,
  getShareFeedback,
} from "./share-home-state";

function toneClass(item: PreviewItem | null): string {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  if (item?.tone === "config") return "dot-config";
  return "dot-skill";
}

function buildPredictedPreviewItem(pasteValue: string, entries: File[]): PreviewItem | null {
  if (entries.length > 1) {
    return {
      name: `${entries.length} files`,
      kind: "Config", meta: "Analyzing...", tone: "config",
    };
  }

  if (entries.length === 1) {
    const entry = entries[0] as File & { relativePath?: string; webkitRelativePath?: string };
    const normalizedName = (entry.relativePath || entry.webkitRelativePath || entry.name).toLowerCase();

    if (normalizedName.endsWith("/skill.md") || normalizedName === "skill.md") {
      return { name: entry.name, kind: "Skill", meta: "Analyzing...", tone: "skill" };
    }
    if (normalizedName.endsWith("/agents.md") || normalizedName === "agents.md") {
      return { name: entry.name, kind: "Agent", meta: "Analyzing...", tone: "agent" };
    }
    if (normalizedName.includes("mcp")) {
      return { name: entry.name, kind: "MCP", meta: "Analyzing...", tone: "mcp" };
    }
    return { name: entry.name, kind: "Config", meta: "Analyzing...", tone: "config" };
  }

  const trimmed = pasteValue.trimStart();
  if (!trimmed) return null;

  const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  return {
    name: isJson ? "clipboard.jsonc" : "clipboard.md",
    kind: /^#{1,6}\s/m.test(trimmed) || /\b(Identity|Scope|Trigger|Parameters):/m.test(trimmed) || /^##\s+(Trigger|Parameters)\b/m.test(trimmed)
      ? "Skill"
      : "Config",
    meta: "Analyzing...",
    tone: /^#{1,6}\s/m.test(trimmed) || /\b(Identity|Scope|Trigger|Parameters):/m.test(trimmed) || /^##\s+(Trigger|Parameters)\b/m.test(trimmed)
      ? "skill"
      : "config",
  };
}

function buildVirtualEntry(content: string): EntryLike {
  const normalized = String(content || "");
  const trimmed = normalized.trimStart();
  const isJsonLike = trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("//") || trimmed.startsWith("/*");

  return {
    name: isJsonLike ? "clipboard.jsonc" : "clipboard.md",
    async text() {
      return normalized;
    }
  };
}

async function fileToPayload(file: EntryLike): Promise<FilePayload> {
  const f = file as EntryLike & { relativePath?: string; webkitRelativePath?: string; path?: string };
  return {
    name: file.name,
    path: f.relativePath || f.webkitRelativePath || f.path || file.name,
    content: await file.text()
  };
}

function flattenEntries(entry: FileSystemEntry, prefix = ""): Promise<File[]> {
  return new Promise((resolve, reject) => {
    if (entry?.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => {
          (file as File & { relativePath: string }).relativePath = `${prefix}${file.name}`;
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

    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const files: File[] = [];

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

async function collectDroppedFiles(dataTransfer: DataTransfer | null): Promise<File[]> {
  const items = Array.from(dataTransfer?.items || []);
  if (!items.length) return Array.from(dataTransfer?.files || []);
  const collected: File[] = [];

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

const DEFAULT_STATUS = "# TODO  Paste AGENTS.md, SKILL.md, or JSON/JSONC config here.";

const BASELINE_EXAMPLE = `# My Skill

Identity: a short description of what this skill does.

Scope: the boundaries and focus area for this skill.

## Trigger

Runs when a specific event or condition is met.

## Parameters

- param_one: Description of the first parameter
- param_two: Description of the second parameter
`;

export default function ShareHomeClient() {
  const [selectedEntries, setSelectedEntries] = useState<File[]>([]);
  const [pasteValue, setPasteValue] = useState("");
  const [preview, setPreview] = useState<PackageResponse | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busyMode, setBusyMode] = useState<BusyMode>(null);
  const [dropActive, setDropActive] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("ready-not-copied");
  const [previewCopied, setPreviewCopied] = useState(false);
  const [pasteState, setPasteState] = useState(DEFAULT_STATUS);
  const [predictedPreviewItem, setPredictedPreviewItem] = useState<PreviewItem | null>(null);
  const requestIdRef = useRef<number>(0);

  const trimmedPaste = useMemo(() => pasteValue.trim(), [pasteValue]);
  const hasPastedSkill = trimmedPaste.length > 0;
  const showExamples = !trimmedPaste && !selectedEntries.length;
  const busy = busyMode !== null;
  const effectiveEntries: EntryLike[] = useMemo(
    () => (selectedEntries.length ? selectedEntries : hasPastedSkill ? [buildVirtualEntry(trimmedPaste)] : []),
    [selectedEntries, hasPastedSkill, trimmedPaste]
  );

  const pasteCountLabel = `${trimmedPaste.length} ${trimmedPaste.length === 1 ? "character" : "characters"}`;
  const showBaseline = !pasteValue;
  const highlightedPaste = useMemo(
    () => showBaseline ? highlightSyntax(BASELINE_EXAMPLE) : highlightSyntax(pasteValue),
    [pasteValue, showBaseline]
  );
  const exampleItems = useMemo(() => getPreviewItems(null), []);
  const activeExampleName = exampleItems.find(item => item.example === pasteValue)?.name ?? null;
  const activePreviewItem = showExamples ? null : preview?.items?.[0] ?? predictedPreviewItem;
  const packageStatus = useMemo(
    () => getPackageStatus({ generatedUrl, warnings, effectiveEntryCount: effectiveEntries.length }),
    [generatedUrl, warnings, effectiveEntries.length]
  );
  const shareFeedback = useMemo(() => getShareFeedback(copyState), [copyState]);
  const selectionLabel = getSelectionLabel(effectiveEntries.length > 0);
  const previewFilename = getPreviewFilename({
    selectedEntryCount: selectedEntries.length,
    selectedEntryName: selectedEntries[0]?.name ?? null,
    hasPastedContent: hasPastedSkill,
  });
  const previewCopyValue = showBaseline ? BASELINE_EXAMPLE : pasteValue;

  const requestPackage = async (previewOnly: boolean): Promise<PackageResponse> => {
    const files = await Promise.all(effectiveEntries.map(fileToPayload));
    const response = await fetch("/v1/package", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ files, preview: previewOnly })
    });

    let json: PackageResponse | null = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok) {
      throw new Error((json as Record<string, unknown> | null)?.message as string || "Packaging failed.");
    }

    return json!;
  };

  useEffect(() => {
    if (!effectiveEntries.length) {
      requestIdRef.current += 1;
      setPreview(null);
      setPredictedPreviewItem(null);
      setGeneratedUrl("");
      setWarnings([]);
      setBusyMode(null);
      setCopyState("ready-not-copied");
      return;
    }

    const currentRequestId = requestIdRef.current + 1;
    requestIdRef.current = currentRequestId;
    let cancelled = false;

    setBusyMode("preview");

    void (async () => {
      try {
        const nextPreview = await requestPackage(true);
        if (cancelled || requestIdRef.current !== currentRequestId) return;
        setPreview(nextPreview);
        if (nextPreview.items?.[0]) {
          setPredictedPreviewItem(nextPreview.items[0]);
        }
      } catch {
        if (cancelled || requestIdRef.current !== currentRequestId) return;
        setPreview(null);
      } finally {
        if (!cancelled && requestIdRef.current === currentRequestId) {
          setBusyMode(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEntries]);

  const resetFormState = () => {
    setPreview(null);
    setGeneratedUrl("");
    setWarnings([]);
    setCopyState("ready-not-copied");
  };

  const assignEntries = async (files: FileList | File[] | null) => {
    const entries = Array.from(files || []).filter(Boolean);
    setSelectedEntries(entries);
    setPredictedPreviewItem(buildPredictedPreviewItem("", entries));
    resetFormState();

    if (entries.length) {
      try {
        const texts = await Promise.all(entries.slice(0, 4).map((f) => f.text()));
        const combined = entries.length === 1
          ? texts[0]
          : texts.map((t, i) => `// --- ${entries[i].name} ---\n${t}`).join("\n\n");
        setPasteValue(combined);
        setPasteState(`Showing ${entries.length === 1 ? entries[0].name : `${entries.length} files`}.`);
      } catch {
        setPasteValue("");
        setPredictedPreviewItem(null);
        setPasteState(DEFAULT_STATUS);
      }
    } else {
      setPasteValue("");
      setPredictedPreviewItem(null);
      setPasteState(DEFAULT_STATUS);
    }
  };

  const handlePasteChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    const hasContent = nextValue.trim().length > 0;

    setPasteValue(nextValue);
    setSelectedEntries([]);
    resetFormState();

    if (!hasContent) {
      setPredictedPreviewItem(null);
    } else if (!trimmedPaste.length) {
      setPredictedPreviewItem(buildPredictedPreviewItem(nextValue, []));
    }

    setPasteState(hasContent ? "Ready to preview." : DEFAULT_STATUS);
  };

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishBundle = async () => {
    if (!effectiveEntries.length || busy) return;

    setBusyMode("publish");

    try {
      const result = await requestPackage(false);
      const nextUrl = typeof result?.url === "string" ? result.url : "";
      let nextCopyState: CopyState = "ready-not-copied";

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

      if (nextCopyState === "copied") {
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
          setCopyState("ready-not-copied");
          copyTimerRef.current = null;
        }, 800);
      }
    } catch {
      // Errors surface through the packageStatus derived state
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

    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopyState("ready-not-copied");
      copyTimerRef.current = null;
    }, 800);
  };

  const copyPreviewText = async () => {
    try {
      await navigator.clipboard.writeText(previewCopyValue);
      setPreviewCopied(true);
      setPasteState("Copied preview to clipboard.");
    } catch {
      setPasteState("Clipboard access was blocked.");
    }

    if (previewCopyTimerRef.current) clearTimeout(previewCopyTimerRef.current);
    previewCopyTimerRef.current = setTimeout(() => {
      setPreviewCopied(false);
      previewCopyTimerRef.current = null;
    }, 300);
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
        </div>

        <div className="share-cards-grid">
          <div className="package-card share-card surface-soft">
            <div className="package-card-header">
              <span className="surface-chip">Package once</span>
              <div className="selection-badge">{selectionLabel}</div>
            </div>

            <h2 className="simple-app-title">Create a share link</h2>
            <p className="simple-app-copy">
              Drop <span className="inline-token token-agent">AGENTS.md</span>,{" "}
              <span className="inline-token token-skill">SKILL.md</span>,{" "}
              <span className="inline-token token-mcp">mcp.json</span>, or{" "}
              <span className="inline-token token-config">config</span> files,
              <span style={{ display: "block" }}>we remove the <span style={{ textDecoration: "line-through", opacity: 0.5 }}>secrets</span>, so share with others more easily.</span>
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
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>
                    <path d="M7 9l5-5 5 5"></path>
                    <path d="M12 4v12"></path>
                  </svg>
                </div>
                <div className="drop-text">
                  <p className="drop-heading">Drag &amp; drop files here</p>
                  <p className="drop-hint">or <span className="drop-browse">browse</span> to upload</p>
                </div>
              </label>

              <div className="included-section">
                <div className="included-section-header">
                  <h4>Example contents</h4>
                </div>
                  <div className="included-list">
                    {exampleItems.map((item) => {
                      const isActive = activeExampleName === item.name;
                      const isDimmed = Boolean(activeExampleName) && !isActive;
                      return (
                        <button
                          type="button"
                          className={`included-item${isActive ? " is-active" : ""}${isDimmed ? " is-dimmed" : ""}`}
                          key={`${item.kind}-${item.name}`}
                          onClick={() => {
                            const nextPasteValue = isActive ? "" : item.example!;
                            setPasteValue(nextPasteValue);
                            setSelectedEntries([]);
                            setPredictedPreviewItem(isActive ? null : item);
                            resetFormState();
                            setPasteState(isActive ? DEFAULT_STATUS : `Loaded "${item.name}" example.`);
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

            <div className="package-actions" aria-live="polite">
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
                <div className="publish-result">
                  <div className={`share-link-row${copyState === "copied" ? " is-copied" : ""}`}>
                    <div className="share-link-inline mono">{generatedUrl}</div>
                    <button className={`copy-icon-button${copyState === "copied" ? " is-copied" : ""}`} type="button" onClick={copyGeneratedUrl} title="Copy link">
                      {copyState === "copied" ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                      )}
                    </button>
                  </div>
                  <a className="button-primary" href={generatedUrl} target="_blank" rel="noreferrer">
                    Open share page
                  </a>
                </div>
              ) : (
                <div className="publish-action">
                  <p className="publish-hint">Creates a public URL that anyone can use to import this config.</p>
                  <button
                    className="button-primary publish-button"
                    type="button"
                    onClick={() => void publishBundle()}
                    disabled={busyMode === "publish" || !effectiveEntries.length}
                  >
                    {busyMode === "publish" ? "Publishing..." : "🔗 Generate share link"}
                  </button>
                </div>
              )}
            </div>

          </div>

          <aside className="preview-panel">
            <div className="preview-surface">
              <div className="preview-header">
                <span className="preview-eyebrow">Preview</span>
                <div className="preview-header-actions">
                  <span className="preview-filename">
                    <span className={`preview-filename-dot ${activePreviewItem ? toneClass(activePreviewItem) : "dot-pending"}`} />
                    {previewFilename}
                    <button
                      type="button"
                      className="clipboard-egg-button preview-copy-button clipboard-egg-inline"
                      title="Copy preview"
                      aria-label="Copy preview"
                      onClick={() => void copyPreviewText()}
                    >
                      {previewCopied ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                      )}
                    </button>
                  </span>
                </div>
              </div>
              <div className="preview-editor-wrap">
                <pre
                  className="preview-highlight"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: highlightedPaste + "\n" }}
                />
                <textarea
                  className="preview-editor"
                  value={pasteValue}
                  onChange={handlePasteChange}
                  placeholder=""
                  spellCheck={false}
                />
              </div>
              <div className="preview-footer">
                <span>{pasteCountLabel}</span>
              </div>
            </div>
          </aside>
        </div>
    </section>
  );
}
