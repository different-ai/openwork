"use client";

import { useMemo, useRef, useState } from "react";

import type { BundlePageProps } from "../server/_lib/types.ts";
import { ResponsiveGrain } from "./responsive-grain";
import ShareNav from "./share-nav";
import SkillEditorSurface from "./skill-editor-surface";
import { DEFAULT_SKILL_DESCRIPTION, parseSkillMarkdown } from "./skill-markdown";

const OPENWORK_DEN_URL = "https://openworklabs.com/den";

function toneClass(item: { tone?: string } | null | undefined): string {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  if (item?.tone === "config") return "dot-config";
  return "dot-skill";
}

export default function ShareBundlePage(props: BundlePageProps) {
  const [previewCopied, setPreviewCopied] = useState(false);
  const [activeSelectionId, setActiveSelectionId] = useState(props.previewSelections?.[0]?.id ?? "preview-0");
  const previewCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openInAppUrl = props.openInAppDeepLink || "#";
  const title = props.title || "OpenWork bundle";
  const description = props.description || "OpenWork bundle ready to import.";
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
  const previewName = parsedPreview.name || activeSelection?.name || title;
  const previewDescription = parsedPreview.description || description || DEFAULT_SKILL_DESCRIPTION;
  const previewBody = parsedPreview.body || activeSelection?.text || "";

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
                <h1>{title}</h1>
                <p className="hero-body">{description}</p>
                <div className="button-row share-bundle-actions">
                  <a className="button-primary" href={openInAppUrl}>
                    Open in OpenWork app
                  </a>
                  <a className="button-secondary" href={OPENWORK_DEN_URL} target="_blank" rel="noreferrer">
                    Open in an OpenWork den
                  </a>
                </div>
              </div>
            </section>

            <section className="share-bundle-stack">
              <article className="result-card share-install-card">
                <div className="share-inline-steps">
                  <div className="share-inline-step">
                    <span className="step-bullet">01</span>
                    <span>Open the bundle in OpenWork</span>
                  </div>
                  <div className="share-inline-step">
                    <span className="step-bullet">02</span>
                    <span>Choose the destination worker</span>
                  </div>
                  <div className="share-inline-step">
                    <span className="step-bullet">03</span>
                    <span>Happy OpenWorking!</span>
                  </div>
                </div>
              </article>

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

              <SkillEditorSurface
                className="share-bundle-editor"
                toneClassName={toneClass(activeSelection)}
                filename="skill.md"
                skillName={previewName}
                skillDescription={previewDescription}
                bodyValue={previewBody}
                metadataMode="readonly"
                readOnly={true}
                copied={previewCopied}
                onCopy={() => void copyPreview()}
              />
            </section>
          </>
        )}
      </main>
    </>
  );
}
