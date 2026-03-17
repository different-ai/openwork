"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

import type { BundlePageProps } from "../server/_lib/types.ts";
import ShareNav from "./share-nav";
import SkillEditorSurface from "./skill-editor-surface";
import { parseSkillMarkdown } from "./skill-markdown";

type BundleSelection = NonNullable<BundlePageProps["previewSelections"]>[number];

const SPECIAL_TOKENS: Record<string, string> = {
  api: "API",
  json: "JSON",
  jsonc: "JSONC",
  mcp: "MCP",
  md: "MD",
  mdx: "MDX",
  opencode: "OpenCode",
  openwork: "OpenWork",
  yaml: "YAML",
  yml: "YAML",
};

function humanizeLabel(value: string | null | undefined): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (!normalized) return "OpenWork Bundle";

  return normalized
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (SPECIAL_TOKENS[lower]) return SPECIAL_TOKENS[lower];
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function formatSurfaceEyebrow(selection: BundleSelection | undefined, parsedName: string, fallbackTitle: string | undefined): string {
  if (selection?.tone === "skill") {
    return humanizeLabel(parsedName || selection.name || fallbackTitle || "Skill");
  }

  if (selection?.tone === "command") {
    return humanizeLabel(selection.name || "Command");
  }

  if (selection?.tone === "agent") {
    const label = humanizeLabel(selection.name || "Agent");
    return /agent$/i.test(label) ? label : `${label} Agent`;
  }

  if (selection?.tone === "mcp") {
    const label = humanizeLabel(selection.name || "MCP");
    return /mcp$/i.test(label) ? label : `${label} MCP`;
  }

  const filename = selection?.filename || selection?.name || fallbackTitle || "config";
  if (/^openwork\.json$/i.test(filename)) return "OpenWork Config";
  if (/^opencode\.jsonc?$/i.test(filename)) return "OpenCode Config";

  const label = humanizeLabel(filename);
  return /config$/i.test(label) ? label : `${label} Config`;
}

function toneClass(item: { tone?: string } | null | undefined): string {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  if (item?.tone === "config") return "dot-config";
  return "dot-skill";
}

export default function ShareBundlePage(props: BundlePageProps & { stars?: string }) {
  const [previewCopied, setPreviewCopied] = useState(false);
  const [activeSelectionId, setActiveSelectionId] = useState(props.previewSelections?.[0]?.id ?? "preview-0");
  const previewCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openInAppUrl = props.openInAppDeepLink || "#";
  const previewSelections = props.previewSelections?.length
    ? props.previewSelections
    : [
        {
          id: "preview-0",
          name: props.title || "Untitled skill",
          filename: props.previewFilename || "skill.md",
          text: props.previewText || "",
          tone: props.previewTone || "skill",
          label: props.previewLabel || "Skill preview",
        },
      ];
  const activeSelection = previewSelections.find((selection) => selection.id === activeSelectionId) ?? previewSelections[0];
  const parsedPreview = useMemo(() => parseSkillMarkdown(activeSelection?.text || ""), [activeSelection?.text]);
  const surfaceEyebrow = formatSurfaceEyebrow(activeSelection, parsedPreview.name, props.title);
  const previewFilename = activeSelection?.filename || props.previewFilename || "bundle.json";
  const showBundleSidebar = previewSelections.length > 1 || Boolean(props.metadataRows?.length);
  const isSingleSkill = props.bundleType === "skill" && previewSelections.length === 1;

  const copyPreview = async () => {
    if (!activeSelection?.text) return;

    try {
      await navigator.clipboard.writeText(activeSelection.text);
      setPreviewCopied(true);
    } catch {
      setPreviewCopied(false);
    }

    if (previewCopyTimerRef.current) clearTimeout(previewCopyTimerRef.current);
    previewCopyTimerRef.current = setTimeout(() => {
      setPreviewCopied(false);
      previewCopyTimerRef.current = null;
    }, 800);
  };

  const buildOpenInAppLaunchUrl = () => {
    if (!openInAppUrl || openInAppUrl === "#") return openInAppUrl;

    try {
      const url = new URL(openInAppUrl);
      const nonce = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.round(Math.random() * 1_000_000_000)}`;
      url.searchParams.set("ow_nonce", nonce);
      return url.toString();
    } catch {
      return openInAppUrl;
    }
  };

  const refreshOpenInAppHref = (anchor: HTMLAnchorElement) => {
    const launchUrl = buildOpenInAppLaunchUrl();
    if (launchUrl) {
      anchor.href = launchUrl;
    }
    return launchUrl;
  };

  const openInOpenWork = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!openInAppUrl || openInAppUrl === "#") return;
    event.preventDefault();

    window.location.assign(refreshOpenInAppHref(event.currentTarget));
  };

  const prepareOpenInOpenWork = (event: PointerEvent<HTMLAnchorElement> | MouseEvent<HTMLAnchorElement>) => {
    refreshOpenInAppHref(event.currentTarget);
  };

  const prepareOpenInOpenWorkFromKeyboard = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    refreshOpenInAppHref(event.currentTarget);
  };

  const actionButtons = (
    <>
      <button className="button-primary" type="button" onClick={() => void copyPreview()}>
        {previewCopied ? "Copied to clipboard" : "Copy to clipboard"}
      </button>
      <a
        className="button-secondary"
        href={openInAppUrl}
        onPointerDown={prepareOpenInOpenWork}
        onMouseDown={prepareOpenInOpenWork}
        onKeyDown={prepareOpenInOpenWorkFromKeyboard}
        onClick={openInOpenWork}
      >
        Open in OpenWork
      </a>
    </>
  );

  return (
    <main className="shell">
      <ShareNav stars={props.stars} />

      {props.missing ? (
        <section className="status-card">
          <span className="eyebrow">OpenWork Share</span>
          <h1>SKILL.md not found</h1>
          <p>
            This share link does not exist anymore, or the bundle id is invalid.
          </p>
          <div className="hero-actions">
            <a className="button-primary" href="/">
              Share another SKILL
            </a>
          </div>
        </section>
      ) : (
        <>
          {isSingleSkill ? (
            <>
              <section className="share-bundle-toolbar surface-shell">
                <div className="button-row share-bundle-actions">{actionButtons}</div>
              </section>

              <section className="share-bundle-simple-stack">
                <SkillEditorSurface
                  className="share-bundle-editor share-bundle-editor-simple"
                  toneClassName={toneClass(activeSelection)}
                  eyebrow={surfaceEyebrow}
                  filename={previewFilename}
                  documentValue={activeSelection?.text || ""}
                  readOnly={true}
                  copied={previewCopied}
                  onCopy={() => void copyPreview()}
                />
              </section>
            </>
          ) : (
            <>
              <section className="share-bundle-hero-card surface-shell">
                <div className="share-bundle-hero-copy">
                  <span className="eyebrow">{props.typeLabel}</span>
                  <h1>{props.title}</h1>
                  {props.description ? <p className="hero-body">{props.description}</p> : null}
                  {props.installHint ? <p className="preview-note">{props.installHint}</p> : null}
                  <div className="button-row share-bundle-actions">{actionButtons}</div>
                </div>

                <aside className="share-bundle-summary surface-soft">
                  <div className="bundle-strip-header">Bundle summary</div>
                  <div className="summary-grid">
                    <div className="summary-stat">
                      <span className="summary-stat-value">{previewSelections.length}</span>
                      <span className="summary-stat-label">Previewable items</span>
                    </div>
                    <div className="summary-stat">
                      <span className="summary-stat-value">{props.typeLabel || "Bundle"}</span>
                      <span className="summary-stat-label">Share type</span>
                    </div>
                    <div className="summary-stat">
                      <span className="summary-stat-value">{props.schemaVersion || "unknown"}</span>
                      <span className="summary-stat-label">Schema version</span>
                    </div>
                    <div className="summary-stat">
                      <span className="summary-stat-value">{surfaceEyebrow}</span>
                      <span className="summary-stat-label">Open now</span>
                    </div>
                  </div>
                </aside>
              </section>

              <section className={`share-bundle-stack${showBundleSidebar ? " has-sidebar" : ""}`}>
                {showBundleSidebar ? (
                  <div className="share-bundle-sidebar">
                    <article className="bundle-compact-strip surface-soft">
                      <div className="bundle-strip-header">Included</div>
                      <div className="bundle-strip-list" aria-label="Included bundle items">
                        {previewSelections.map((selection) => {
                          const isActive = selection.id === activeSelection?.id;
                          return (
                            <button
                              key={selection.id}
                              type="button"
                              className={`included-item${isActive ? " is-active" : ""}`}
                              onClick={() => setActiveSelectionId(selection.id)}
                              disabled={isActive}
                            >
                              <span className="item-left">
                                <span className={`item-dot ${toneClass(selection)}`} />
                                <span className="item-text">
                                  <span className="item-title">{formatSurfaceEyebrow(selection, selection.name, selection.name)}</span>
                                  <span className="item-meta">{selection.label || selection.filename}</span>
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </article>

                    {props.metadataRows?.length ? (
                      <article className="share-bundle-meta-card surface-soft">
                        <div className="bundle-strip-header">Bundle info</div>
                        <dl className="metadata-list share-bundle-metadata-list">
                          {props.metadataRows.map((row) => (
                            <div className="metadata-row" key={row.label}>
                              <dt>{row.label}</dt>
                              <dd>{row.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </article>
                    ) : null}
                  </div>
                ) : null}

                <SkillEditorSurface
                  className="share-bundle-editor"
                  toneClassName={toneClass(activeSelection)}
                  eyebrow={surfaceEyebrow}
                  filename={previewFilename}
                  documentValue={activeSelection?.text || ""}
                  readOnly={true}
                  copied={previewCopied}
                  onCopy={() => void copyPreview()}
                />
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
