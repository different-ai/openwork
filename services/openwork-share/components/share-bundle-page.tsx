"use client";

import { useMemo, useState } from "react";

import type { BundlePageProps } from "../server/_lib/types.ts";
import { ResponsiveGrain } from "./responsive-grain";
import ShareNav from "./share-nav";
import { highlightSyntax } from "./share-preview-syntax";

function toneClass(item: { tone?: string } | null | undefined): string {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  if (item?.tone === "config") return "dot-config";
  return "dot-skill";
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  );
}

function countLabel(text: string | undefined): string {
  const length = String(text ?? "").trim().length;
  return `${length} ${length === 1 ? "character" : "characters"}`;
}

export default function ShareBundlePage(props: BundlePageProps) {
  const [copyState, setCopyState] = useState<"ready" | "copied" | "failed">("ready");
  const [previewCopied, setPreviewCopied] = useState(false);

  const shareUrl = props.shareUrl || "";
  const openInAppUrl = props.openInAppDeepLink || "#";
  const openInWebUrl = props.openInWebAppUrl || "#";
  const jsonUrl = props.jsonUrl || "#";
  const downloadUrl = props.downloadUrl || "#";
  const title = props.title || "OpenWork bundle";
  const description = props.description || "OpenWork bundle ready to import.";

  const highlightedPreview = useMemo(() => highlightSyntax(props.previewText || ""), [props.previewText]);
  const previewFooter = props.previewText
    ? `${countLabel(props.previewText)}${props.previewLabel ? ` · ${props.previewLabel}` : ""}`
    : "Preview unavailable";

  const copyShareUrl = async () => {
    if (!shareUrl) return;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    window.setTimeout(() => setCopyState("ready"), 1800);
  };

  const copyPreview = async () => {
    if (!props.previewText) return;

    try {
      await navigator.clipboard.writeText(props.previewText);
      setPreviewCopied(true);
    } catch {
      setPreviewCopied(false);
    }

    window.setTimeout(() => setPreviewCopied(false), 800);
  };

  return (
    <>
      <div className="grain-background">
        <ResponsiveGrain
          colors={["#f6f9fc", "#f6f9fc", "#1e293b", "#334155"]}
          colorBack="#f6f9fc"
          softness={1}
          intensity={0.03}
          noise={0.14}
          shape="corners"
          speed={0.2}
        />
      </div>

      <main className="shell">
        <ShareNav />

        {props.missing ? (
          <section className="status-card">
            <span className="eyebrow">OpenWork Share</span>
            <h1>Bundle not found</h1>
            <p>
              This share link does not exist anymore, or the bundle id is invalid.
            </p>
            <div className="hero-actions">
              <a className="button-primary" href="/">
                Package another worker
              </a>
            </div>
          </section>
        ) : (
          <>
            <section className="hero-layout hero-layout-share">
              <div className="hero-copy">
                <span className="eyebrow">{props.typeLabel}</span>
                <h1>
                  {title}
                </h1>
                <p className="hero-body">{description}</p>
                <div className="button-row">
                  <a className="button-primary" href={openInAppUrl}>
                    Open in app
                  </a>
                  <a className="button-secondary" href={openInWebUrl} target="_blank" rel="noreferrer">
                    Open in web app
                  </a>
                </div>
                <p className="hero-note">{props.installHint}</p>
              </div>

              <div className="share-cards-grid share-bundle-grid">
                <article className="package-card share-card surface-soft">
                  <h2 className="simple-app-title">Package contents</h2>
                  <p className="simple-app-copy">
                    Everything bundled in this share link.
                  </p>

                  <div className="included-section">
                    <div className="included-section-header">
                      <h4>Package contents</h4>
                      <span className="surface-chip">Top {props.items?.length || 1}</span>
                    </div>

                    <div className="included-list">
                      {props.items?.length ? (
                        props.items.map((item) => (
                          <div className="included-item" key={`${item.kind}-${item.name}`}>
                            <div className="item-left">
                              <div className={`item-dot ${toneClass(item)}`}></div>
                              <div className="item-text">
                                <span className="item-title">{item.name}</span>
                                <span className="item-meta">
                                  {item.kind} · {item.meta}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="included-item">
                          <div className="item-left">
                            <div className="item-dot dot-skill"></div>
                            <div className="item-text">
                              <span className="item-title">OpenWork bundle</span>
                              <span className="item-meta">Shared config</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </article>

                <aside className="preview-panel share-preview-panel">
                  <div className="preview-surface">
                    <div className="preview-header">
                      <span className="preview-eyebrow">Preview</span>

                      <div className="preview-header-actions">
                        <span className="preview-filename">
                          <span className="preview-filename-dot dot-pending" />
                          {props.previewFilename || "bundle.json"}
                          <button
                            type="button"
                            className="clipboard-egg-button preview-copy-button clipboard-egg-inline"
                            title="Copy preview"
                            aria-label="Copy preview"
                            onClick={() => void copyPreview()}
                          >
                            {previewCopied ? <CheckIcon /> : <CopyIcon />}
                          </button>
                        </span>
                      </div>
                    </div>

                    <div className="preview-editor-wrap">
                      <pre className="preview-highlight share-preview-readonly" dangerouslySetInnerHTML={{ __html: `${highlightedPreview}\n` }} />
                    </div>

                    <div className="preview-footer">
                      <span>{previewFooter}</span>
                    </div>
                  </div>
                </aside>
              </div>
            </section>

            <section className="share-story-grid">
              <article className="result-card">
                <span className="eyebrow">Bundle details</span>
                <h3>Bundle details</h3>
                <p>Stable metadata for parsing and direct OpenWork import.</p>
                <dl className="metadata-list">
                  {props.metadataRows?.map((row) => (
                    <div className="metadata-row" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </article>

              <article className="result-card">
                <span className="eyebrow">Raw endpoints</span>
                <h3>Raw endpoints</h3>
                <p>Keep the human page and machine payload side by side.</p>
                <div className="url-stack">
                  <div className="url-box">
                    <a href={jsonUrl}>JSON payload</a>
                  </div>
                  <div className="url-box mono">{shareUrl}</div>
                </div>
                <div className="button-row">
                  <a className="button-secondary" href={downloadUrl}>
                    Download JSON
                  </a>
                  <button className="button-secondary" type="button" onClick={() => void copyShareUrl()}>
                    {copyState === "copied" ? "Copied!" : "Copy share link"}
                  </button>
                </div>
              </article>

              <article className="result-card">
                <span className="eyebrow">Install path</span>
                <h3>Open it in OpenWork</h3>
                <div className="step-list">
                  <div className="step-row">
                    <span className="step-bullet">01</span>
                    <span>Open the share page or use the deep link directly from this package.</span>
                  </div>
                  <div className="step-row">
                    <span className="step-bullet">02</span>
                    <span>OpenWork reads the bundle metadata, then prepares a new worker import flow.</span>
                  </div>
                  <div className="step-row">
                    <span className="step-bullet">03</span>
                    <span>Your teammate lands in a clean import path with the packaged skills, agents, and MCP setup attached.</span>
                  </div>
                </div>
              </article>
            </section>
          </>
        )}
      </main>
    </>
  );
}
