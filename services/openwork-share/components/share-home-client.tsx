"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { BusyMode, EntryLike, FilePayload, PackageResponse, PreviewItem } from "./share-home-types";
import { highlightSyntax } from "./share-preview-syntax";
import { getPackageStatus, getPreviewFilename } from "./share-home-state";

const DEFAULT_SKILL_NAME = "skill.md";
const DEFAULT_SKILL_DESCRIPTION = "This is a skill I'm currently using.";
const DEFAULT_STATUS = "Upload a single file or paste skill content below.";
const MISSING_METADATA_ERROR = "Skills need name and description.";
const MULTI_FILE_ERROR = "Upload or paste a single skill to continue.";

const BASELINE_BODY = `# Agent Creator

Any markdown body is acceptable here.
`;

function toneClass(item: PreviewItem | null): string {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  if (item?.tone === "config") return "dot-config";
  return "dot-skill";
}

function yamlValue(value: string): string {
  const normalized = String(value ?? "").trim();
  if (/^[A-Za-z0-9._/\- ]+$/.test(normalized) && !normalized.includes(":")) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

function composeSkillMarkdown(name: string, description: string, body: string): string {
  const normalizedBody = String(body ?? "").replace(/\r\n/g, "\n").trim();
  const frontmatter = [
    "---",
    `name: ${yamlValue(name)}`,
    `description: ${yamlValue(description)}`,
    "---",
  ].join("\n");

  return normalizedBody ? `${frontmatter}\n\n${normalizedBody}\n` : `${frontmatter}\n`;
}

function buildVirtualEntry(name: string, content: string): EntryLike {
  const normalized = String(content || "");
  return {
    name: name.trim() || DEFAULT_SKILL_NAME,
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

function parseUploadedSkill(content: string): { name: string; description: string; body: string; hasFrontmatter: boolean } {
  const text = String(content ?? "").replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return {
      name: "",
      description: "",
      body: text,
      hasFrontmatter: false,
    };
  }

  const header = match[1] ?? "";
  const body = text.slice(match[0].length);
  const nameMatch = header.match(/^name:\s*(.+)$/m);
  const descriptionMatch = header.match(/^description:\s*(.+)$/m);

  const normalizeField = (value: string | undefined): string =>
    String(value ?? "")
      .trim()
      .replace(/^['"]|['"]$/g, "");

  return {
    name: normalizeField(nameMatch?.[1]) || DEFAULT_SKILL_NAME,
    description: normalizeField(descriptionMatch?.[1]) || DEFAULT_SKILL_DESCRIPTION,
    body,
    hasFrontmatter: true,
  };
}

function buildPredictedPreviewItem(skillName: string, hasBody: boolean): PreviewItem | null {
  if (!hasBody) return null;
  return {
    name: skillName.trim() || DEFAULT_SKILL_NAME,
    kind: "Skill",
    meta: "Checking skill...",
    tone: "skill",
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

export default function ShareHomeClient() {
  const [uploadedFileCount, setUploadedFileCount] = useState(0);
  const [skillName, setSkillName] = useState(DEFAULT_SKILL_NAME);
  const [skillDescription, setSkillDescription] = useState(DEFAULT_SKILL_DESCRIPTION);
  const [bodyValue, setBodyValue] = useState("");
  const [preview, setPreview] = useState<PackageResponse | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busyMode, setBusyMode] = useState<BusyMode>(null);
  const [dropActive, setDropActive] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState(DEFAULT_STATUS);
  const [errorMessage, setErrorMessage] = useState("");
  const [predictedPreviewItem, setPredictedPreviewItem] = useState<PreviewItem | null>(null);
  const requestIdRef = useRef<number>(0);

  const trimmedBody = useMemo(() => bodyValue.trim(), [bodyValue]);
  const hasBody = trimmedBody.length > 0;
  const hasRequiredMetadata = skillName.trim().length > 0 && skillDescription.trim().length > 0;
  const generatedSkillMarkdown = useMemo(
    () => composeSkillMarkdown(skillName, skillDescription, bodyValue),
    [bodyValue, skillDescription, skillName],
  );
  const effectiveEntries: EntryLike[] = useMemo(
    () => (uploadedFileCount > 1 ? [] : hasBody && hasRequiredMetadata ? [buildVirtualEntry(skillName, generatedSkillMarkdown)] : []),
    [generatedSkillMarkdown, hasBody, hasRequiredMetadata, skillName, uploadedFileCount],
  );
  const busy = busyMode !== null;
  const showBaseline = !bodyValue;
  const highlightedBody = useMemo(
    () => highlightSyntax(showBaseline ? BASELINE_BODY : bodyValue),
    [bodyValue, showBaseline],
  );
  const packageStatus = useMemo(
    () => getPackageStatus({ errorMessage, warnings, effectiveEntryCount: effectiveEntries.length }),
    [effectiveEntries.length, errorMessage, warnings],
  );
  const activePreviewItem = preview?.items?.[0] ?? predictedPreviewItem;
  const previewFilename = getPreviewFilename({
    selectedEntryCount: uploadedFileCount,
    selectedEntryName: skillName || DEFAULT_SKILL_NAME,
    hasPastedContent: hasBody,
    manualName: skillName,
  });
  const publishDisabled = busy || !hasBody || !hasRequiredMetadata || Boolean(errorMessage) || uploadedFileCount > 1;
  const previewCopyValue = generatedSkillMarkdown;
  const bodyCountLabel = `${trimmedBody.length} ${trimmedBody.length === 1 ? "character" : "characters"}`;

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
    setPredictedPreviewItem(buildPredictedPreviewItem(skillName, hasBody));
  }, [hasBody, skillName]);

  useEffect(() => {
    if (uploadedFileCount > 1) {
      requestIdRef.current += 1;
      setPreview(null);
      setWarnings([]);
      setErrorMessage(MULTI_FILE_ERROR);
      return;
    }

    if (!hasRequiredMetadata) {
      requestIdRef.current += 1;
      setPreview(null);
      setWarnings([]);
      setErrorMessage(MISSING_METADATA_ERROR);
      return;
    }

    if (!hasBody) {
      requestIdRef.current += 1;
      setPreview(null);
      setWarnings([]);
      setErrorMessage("");
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
  }, [effectiveEntries, hasBody, hasRequiredMetadata, uploadedFileCount]);

  const assignEntries = async (files: FileList | File[] | null) => {
    const entries = Array.from(files || []).filter(Boolean);
    setUploadedFileCount(entries.length);
    setPreview(null);
    setWarnings([]);

    if (entries.length > 1) {
      setBodyValue("");
      setErrorMessage(MULTI_FILE_ERROR);
      setStatusMessage("Only one file can be uploaded at a time.");
      return;
    }

    if (!entries.length) {
      setBodyValue("");
      setErrorMessage("");
      setStatusMessage(DEFAULT_STATUS);
      return;
    }

    try {
      const rawContent = await entries[0].text();
      const parsed = parseUploadedSkill(rawContent);
      setSkillName(parsed.hasFrontmatter ? parsed.name : (current) => current || DEFAULT_SKILL_NAME);
      setSkillDescription(parsed.hasFrontmatter ? parsed.description : (current) => current || DEFAULT_SKILL_DESCRIPTION);
      setBodyValue(parsed.body);
      setErrorMessage("");
      setStatusMessage(`Loaded ${entries[0].name}.`);
    } catch {
      setBodyValue("");
      setErrorMessage("Could not read the uploaded file.");
      setStatusMessage(DEFAULT_STATUS);
    } finally {
      setUploadedFileCount(0);
    }
  };

  const handleBodyChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setBodyValue(event.target.value);
    setPreview(null);
    setWarnings([]);
    setStatusMessage(event.target.value.trim() ? "Skill body ready to validate." : DEFAULT_STATUS);
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
              <p className="simple-app-copy">Set the required frontmatter values, add any markdown body, and open the finished share page directly.</p>
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
                <p className="drop-heading">Drag and drop a file here</p>
                <p className="drop-hint">or <span className="drop-browse">browse</span> to upload</p>
              </div>
              <p className="share-upload-note">The file name does not matter. We generate the skill frontmatter below.</p>
            </label>

            <div className="share-upload-actions">
              <div className="share-metadata-grid">
                <label className="share-metadata-field">
                  <span className="share-metadata-key">name:</span>
                  <input
                    aria-label="Skill name"
                    className="share-metadata-input mono"
                    value={skillName}
                    onChange={(event) => setSkillName(event.target.value)}
                  />
                </label>

                <label className="share-metadata-field">
                  <span className="share-metadata-key">description:</span>
                  <input
                    aria-label="Skill description"
                    className="share-metadata-input"
                    value={skillDescription}
                    onChange={(event) => setSkillDescription(event.target.value)}
                  />
                </label>
              </div>

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

            <div className="share-frontmatter-preview mono">
              <span>---</span>
              <span>name: {yamlValue(skillName || DEFAULT_SKILL_NAME)}</span>
              <span>description: {yamlValue(skillDescription || DEFAULT_SKILL_DESCRIPTION)}</span>
              <span>---</span>
            </div>

            <div className="preview-editor-wrap">
              <pre
                className="preview-highlight"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: `${highlightedBody}\n` }}
              />
              <textarea
                className="preview-editor"
                value={bodyValue}
                onChange={handleBodyChange}
                placeholder=""
                spellCheck={false}
              />
            </div>

            <div className="preview-footer">
              <span>{bodyCountLabel}</span>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
