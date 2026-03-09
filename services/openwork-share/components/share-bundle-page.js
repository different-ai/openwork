"use client";

import { useState } from "react";

import ShareNav from "./share-nav";

function toneClass(item) {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  return "dot-skill";
}

export default function ShareBundlePage(props) {
  const [copyState, setCopyState] = useState("Copy share link");
  const bundleSummary = [
    { label: "Schema", value: props.schemaVersion || "-" },
    { label: "Type", value: props.typeLabel || "Package" },
    { label: "Items", value: props.items?.length || 1 }
  ];

  const copyShareUrl = async () => {
    if (!props.shareUrl) return;
    try {
      await navigator.clipboard.writeText(props.shareUrl);
      setCopyState("Copied!");
      window.setTimeout(() => setCopyState("Copy share link"), 2000);
    } catch {
      setCopyState("Copy failed");
      window.setTimeout(() => setCopyState("Copy share link"), 2000);
    }
  };

  return (
    <>
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
                  {props.title} <em>ready</em>
                </h1>
                <p className="hero-body">{props.description}</p>
                <div className="hero-proof-strip">
                  {bundleSummary.map((item) => (
                    <span className="surface-chip" key={item.label}>
                      {item.label}: {item.value}
                    </span>
                  ))}
                </div>
                <div className="hero-actions">
                  <a className="button-primary" href={props.openInAppDeepLink}>
                    Open in app
                  </a>
                  <a className="button-secondary" href={props.openInWebAppUrl} target="_blank" rel="noreferrer">
                    Open in web app
                  </a>
                </div>
                <p className="hero-note">{props.installHint}</p>
              </div>

              <div className="hero-artifact hero-artifact-share">
                <div className="artifact-window">
                  <div className="artifact-window-header">
                    <div className="mac-dots" aria-hidden="true">
                      <div className="mac-dot red"></div>
                      <div className="mac-dot yellow"></div>
                      <div className="mac-dot green"></div>
                    </div>
                    <div className="artifact-window-title">OpenWork Share</div>
                  </div>

                  <div className="artifact-window-body">
                    <div className="preview-panel preview-panel-standalone surface-shell">
                      <div className="preview-panel-header">
                        <span className="surface-chip">Bundle preview</span>
                        <span className="preview-state is-ready">Import ready</span>
                      </div>

                      <h3 className="simple-app-title">Package contents</h3>
                      <p className="simple-app-copy">
                        This share page keeps the landing-style shell while preserving the machine-readable payload OpenWork needs for direct import.
                      </p>

                      <div className="summary-grid">
                        {bundleSummary.map((item) => (
                          <div className="summary-stat" key={item.label}>
                            <strong className="summary-stat-value">{item.value}</strong>
                            <span className="summary-stat-label">{item.label}</span>
                          </div>
                        ))}
                      </div>

                      <div className="included-section">
                        <h4>Package contents</h4>
                        <div className="included-list">
                          {props.items.length ? (
                            props.items.map((item) => (
                              <div className="included-item" key={`${item.kind}-${item.name}`}>
                                <div className="item-left">
                                  <div className={`item-dot ${toneClass(item)}`}></div>
                                  <div>
                                    <div className="item-title">{item.name}</div>
                                    <div className="item-meta">
                                      {item.kind} · {item.meta}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="included-item">
                              <div className="item-left">
                                <div className="item-dot dot-skill"></div>
                                <div>
                                  <div className="item-title">OpenWork bundle</div>
                                  <div className="item-meta">Shared config</div>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="story-grid">
              <article className="story-card">
                <span className="eyebrow">Bundle details</span>
                <h3>Bundle details</h3>
                <p>Stable metadata for parsing and direct OpenWork import.</p>
                <dl className="metadata-list">
                  {props.metadataRows.map((row) => (
                    <div className="metadata-row" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </article>

              <article className="story-card">
                <span className="eyebrow">Raw endpoints</span>
                <h3>Raw endpoints</h3>
                <p>Keep the human page and machine payload side by side.</p>
                <div className="url-stack">
                  <div className="url-box">
                    <a href={props.jsonUrl}>JSON payload</a>
                  </div>
                  <div className="url-box mono">{props.shareUrl}</div>
                </div>
                <div className="button-row">
                  <a className="button-secondary" href={props.downloadUrl}>
                    Download JSON
                  </a>
                  <button className="button-secondary" type="button" onClick={copyShareUrl}>
                    {copyState}
                  </button>
                </div>
              </article>

              <article className="story-card">
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
