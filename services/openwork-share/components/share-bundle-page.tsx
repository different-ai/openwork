"use client";

import { useMemo, useRef, useState, type MouseEvent } from "react";

import type { BundlePageProps } from "../server/_lib/types.ts";
import ShareNav from "./share-nav";
import SkillEditorSurface from "./skill-editor-surface";
import { parseSkillMarkdown } from "./skill-markdown";

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
  const previewName = parsedPreview.name || activeSelection?.name || props.title || "OpenWork bundle";
  const showBundleSidebar = previewSelections.length > 1;

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

  const openInOpenWork = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!openInAppUrl || openInAppUrl === "#") return;
    event.preventDefault();

    try {
      const url = new URL(openInAppUrl);
      url.searchParams.set("ow_nonce", `${Date.now()}`);
      window.location.assign(url.toString());
    } catch {
      window.location.assign(openInAppUrl);
    }
  };

  return (
    <main className="shell">
      <ShareNav stars={props.stars} />

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
              <h1>Skill share</h1>
              <div className="button-row share-bundle-actions">
                <button className="button-primary" type="button" onClick={() => void copyPreview()}>
                  {previewCopied ? "Copied to clipboard" : "Copy to clipboard"}
                </button>
                <a className="button-secondary" href={openInAppUrl} onClick={openInOpenWork}>
                  Open in OpenWork
                </a>
              </div>
            </div>
          </section>

          <section className={`share-bundle-stack${showBundleSidebar ? " has-sidebar" : ""}`}>
            {showBundleSidebar ? (
              <article className="bundle-compact-strip surface-soft">
                <div className="bundle-strip-header">Skills:</div>
                <div className="bundle-strip-list" aria-label="Skills">
                  {previewSelections.map((selection) => {
                    const isActive = selection.id === activeSelection?.id;
                    return (
                      <button
                        key={selection.id}
                        type="button"
                        className={`bundle-strip-chip${isActive ? " is-active" : ""}`}
                        onClick={() => setActiveSelectionId(selection.id)}
                        disabled={isActive}
                      >
                        <span className={`preview-filename-dot ${toneClass(selection)}`} />
                        {selection.name}
                      </button>
                    );
                  })}
                </div>
              </article>
            ) : null}

            <SkillEditorSurface
              className="share-bundle-editor"
              toneClassName={toneClass(activeSelection)}
              filename={previewName}
              documentValue={activeSelection?.text || ""}
              readOnly={true}
              copied={previewCopied}
              onCopy={() => void copyPreview()}
            />
          </section>
        </>
      )}
    </main>
  );
}
