"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { BusyMode, EntryLike, FilePayload, PackageResponse, PreviewItem } from "./share-home-types";
import { highlightSyntax } from "./share-preview-syntax";
import { getPackageStatus, getPreviewFilename } from "./share-home-state";

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
      kind: "Skill",
      meta: "Single skill only",
      tone: "skill",
    };
  }

  if (entries.length === 1) {
    return {
      name: entries[0].name,
      kind: "Skill",
      meta: "Checking skill...",
      tone: "skill",
    };
  }

  const trimmed = pasteValue.trimStart();
  if (!trimmed) return null;

  const looksLikeSkill = /^#{1,6}\s/m.test(trimmed) || /\b(Identity|Trigger|Scope|Parameters):/m.test(trimmed);
  return {
    name: looksLikeSkill ? "clipboard.md" : "clipboard.txt",
    kind: looksLikeSkill ? "Skill" : "Config",
    meta: looksLikeSkill ? "Checking skill..." : "Not a skill yet",
    tone: looksLikeSkill ? "skill" : "config",
  };
}

function buildVirtualEntry(content: string): EntryLike {
  const normalized = String(content || "");
  return {
    name: "clipboard.md",
    async text() {
      return normalized;
    },
  };
}

async function fileToPayload(file: EntryLike): Promise<FilePayload> {
  const f = file as EntryLike & { relativePath?: string; webkitRelativePath?: string; path?: string };
  return {
    name: file.name,
    path: f.relativePath || f.webkitRelativePath || f.path || file.name,
    content: await file.text(),
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
        reject,
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
        reject,
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

const DEFAULT_STATUS = "Upload a single SKILL.md file or paste a skill below.";

const BASELINE_EXAMPLE = `# Detect Instructions

Identity: inspect copied prompts and surface hidden instructions.

## Trigger

Runs when a prompt needs a quick instruction audit.

## Parameters

- source: copied prompt or notes to scan
- focus: which instruction conflicts to flag first
`;

export default function ShareHomeClient() {
  const [selectedEntries, setSelectedEntries] = useState<File[]>([]);
  const [pasteValue, setPasteValue] = useState("");
  const [preview, setPreview] = useState<PackageResponse | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busyMode, setBusyMode] = useState<BusyMode>(null);
  const [dropActive, setDropActive] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState(DEFAULT_STATUS);
  const [errorMessage, setErrorMessage] = useState("");
  const [predictedPreviewItem, setPredictedPreviewItem] = useState<PreviewItem | null>(null);
  const requestIdRef = useRef<number>(0);

  const trimmedPaste = useMemo(() => pasteValue.trim(), [pasteValue]);
  const hasPastedSkill = trimmedPaste.length > 0;
  const busy = busyMode !== null;
  const effectiveEntries: EntryLike[] = useMemo(
    () => (selectedEntries.length ? selectedEntries : hasPastedSkill ? [buildVirtualEntry(trimmedPaste)] : []),
    [selectedEntries, hasPastedSkill, trimmedPaste],
  );

  const pasteCountLabel = `${trimmedPaste.length} ${trimmedPaste.length === 1 ? "character" : "characters"}`;
  const showBaseline = !pasteValue;
  const highlightedPaste = useMemo(
    () => highlightSyntax(showBaseline ? BASELINE_EXAMPLE : pasteValue),
    [pasteValue, showBaseline],
  );
  const activePreviewItem = preview?.items?.[0] ?? predictedPreviewItem;
  const packageStatus = useMemo(
    () => getPackageStatus({ errorMessage, warnings, effectiveEntryCount: effectiveEntries.length }),
    [effectiveEntries.length, errorMessage, warnings],
  );
  const previewFilename = getPreviewFilename({
    selectedEntryCount: selectedEntries.length,
    selectedEntryName: selectedEntries[0]?.name ?? null,
    hasPastedContent: hasPastedSkill,
  });
  const previewCopyValue = showBaseline ? BASELINE_EXAMPLE : pasteValue;
  const publishDisabled = busy || !effectiveEntries.length || Boolean(errorMessage) || selectedEntries.length > 1;

  const requestPackage = async (previewOnly: boolean): Promise<PackageResponse> => {
    const files = await Promise.all(effectiveEntries.map(fileToPayload));
    const response = await fetch("/v1/package", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ files, preview: previewOnly }),
    });

    let json: PackageResponse | { message?: string } | null = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok) {
      throw new Error(json && "message" in json && typeof json.message === "string" ? json.message : "Packaging failed.");
    }

    return json as PackageResponse;
  };

  useEffect(() => {
    if (!effectiveEntries.length) {
      requestIdRef.current += 1;
      setPreview(null);
      setWarnings([]);
      setErrorMessage("");
      setPredictedPreviewItem(null);
      return;
    }

    if (selectedEntries.length > 1) {
      requestIdRef.current += 1;
      setPreview(null);
      setWarnings([]);
      setErrorMessage("Upload a single skill markdown file to continue.");
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
        setWarnings(Array.isArray(nextPreview.warnings) ? nextPreview.warnings : []);
        setErrorMessage("");
        if (nextPreview.items?.[0]) {
          setPredictedPreviewItem(nextPreview.items[0]);
        }
      } catch (error) {
        if (cancelled || requestIdRef.current !== currentRequestId) return;
        setPreview(null);
        setWarnings([]);
        setErrorMessage(error instanceof Error ? error.message : "Packaging failed.");
      } finally {
        if (!cancelled && requestIdRef.current === currentRequestId) {
          setBusyMode(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveEntries, selectedEntries.length]);

  const assignEntries = async (files: FileList | File[] | null) => {
    const entries = Array.from(files || []).filter(Boolean);
    setSelectedEntries(entries);
    setPreview(null);
    setWarnings([]);
    setErrorMessage(entries.length > 1 ? "Upload a single skill markdown file to continue." : "");
    setPredictedPreviewItem(buildPredictedPreviewItem("", entries));

    if (entries.length === 1) {
      try {
        const nextValue = await entries[0].text();
        setPasteValue(nextValue);
        setStatusMessage(`Loaded ${entries[0].name}.`);
        setPredictedPreviewItem(buildPredictedPreviewItem(nextValue, entries));
      } catch {
        setPasteValue("");
        setStatusMessage(DEFAULT_STATUS);
      }
      return;
    }

    setPasteValue("");
    setStatusMessage(entries.length > 1 ? "Only one skill file can be uploaded at a time." : DEFAULT_STATUS);
  };

  const handlePasteChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    const hasContent = nextValue.trim().length > 0;

    setPasteValue(nextValue);
    setSelectedEntries([]);
    setPreview(null);
    setWarnings([]);
    setErrorMessage("");
    setPredictedPreviewItem(hasContent ? buildPredictedPreviewItem(nextValue, []) : null);
    setStatusMessage(hasContent ? "Skill draft ready to validate." : DEFAULT_STATUS);
  };

  const previewCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishBundle = async () => {
    if (publishDisabled) return;

    setBusyMode("publish");

    try {
      const result = await requestPackage(false);
      const nextUrl = typeof result?.url === "string" ? result.url : "";
      if (nextUrl) {
        window.location.assign(nextUrl);
        return;
      }
      setErrorMessage("Share link generation completed without a destination URL.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Packaging failed.");
    } finally {
      setBusyMode(null);
    }
  };

  const copyPreviewText = async () => {
    try {
      await navigator.clipboard.writeText(previewCopyValue);
      setPreviewCopied(true);
      setStatusMessage("Copied preview to clipboard.");
    } catch {
      setStatusMessage("Clipboard access was blocked.");
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
          Share your <em>skill</em>
        </h1>
        <p className="hero-body">Edit and share skills in seconds.</p>
      </div>

      <div className="share-home-stack">
        <div className="package-card share-card surface-soft">
          <div className="share-home-card-header">
            <div>
              <h2 className="simple-app-title">Package skills in seconds</h2>
              <p className="simple-app-copy">Upload one skill file, review the preview, and open the finished share page directly.</p>
            </div>
            <span className="surface-chip">Single skill</span>
          </div>

          <div className="share-upload-grid">
            <label
              className={`drop-zone share-skill-drop-zone${dropActive ? " is-dragover" : ""}`}
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
                void assignEntries(files);
              }}
            >
              <input
                className="visually-hidden"
                type="file"
                multiple
                accept=".md,text/markdown"
                onChange={(event) => {
                  void assignEntries(event.target.files);
                }}
              />
              <div className="drop-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>
                  <path d="M7 9l5-5 5 5"></path>
                  <path d="M12 4v12"></path>
                </svg>
              </div>
              <div className="drop-text">
                <p className="drop-heading">Drag and drop a skill here</p>
                <p className="drop-hint">or <span className="drop-browse">browse</span> to upload</p>
              </div>
              <p className="share-upload-note">Only one `SKILL.md` file at a time.</p>
            </label>

            <div className="share-upload-actions">
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

              <p className="publish-hint">Generate the share link here, then continue on the share page to copy or share it.</p>
              <button
                className="button-primary publish-button"
                type="button"
                onClick={() => void publishBundle()}
                disabled={publishDisabled}
              >
                {busyMode === "publish" ? "Generating..." : "🔗 Generate share link"}
              </button>

              <p className="share-inline-status">{statusMessage}</p>
            </div>
          </div>
        </div>

        <aside className="preview-panel share-home-preview">
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
                dangerouslySetInnerHTML={{ __html: `${highlightedPaste}\n` }}
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
