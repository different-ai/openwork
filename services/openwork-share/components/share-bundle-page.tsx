"use client";

import { useMemo, useRef, useState } from "react";

import type { BundlePageProps } from "../server/_lib/types.ts";
import { ResponsiveGrain } from "./responsive-grain";
import type { PreviewItem } from "./share-home-types";
import ShareNav from "./share-nav";
import SkillEditorSurface from "./skill-editor-surface";
import { composeSkillMarkdown, DEFAULT_SKILL_DESCRIPTION, parseSkillMarkdown, resolveSkillName } from "./skill-markdown";

function toneClass(item: { tone?: string } | null | undefined): string {
  if (item?.tone === "agent") return "dot-agent";
  if (item?.tone === "mcp") return "dot-mcp";
  if (item?.tone === "command") return "dot-command";
  if (item?.tone === "config") return "dot-config";
  return "dot-skill";
}

function compactItemLabel(props: BundlePageProps, item: NonNullable<BundlePageProps["items"]>[number]): string {
  if (props.bundleType === "skill") return "skill.md";
  return item.name;
}

function buildInitialSkillState(props: BundlePageProps) {
  const parsed = parseSkillMarkdown(props.previewText || "");
  return {
    name: parsed.name || props.title || "",
    description: parsed.description || props.description || DEFAULT_SKILL_DESCRIPTION,
    body: parsed.body || props.previewText || "",
  };
}

const INSTALL_STEPS = [
  "Open this share page or jump straight into OpenWork with the import action.",
  "Choose where to add the skill inside OpenWork once the bundle is loaded.",
  "Review the generated skill.md content, then finish the import in OpenWork.",
];

export default function ShareBundlePage(props: BundlePageProps) {
  const [copyState, setCopyState] = useState<"ready" | "copied" | "failed">("ready");
  const [previewCopied, setPreviewCopied] = useState(false);
  const [saveState, setSaveState] = useState<"ready" | "saving" | "failed">("ready");
  const [saveError, setSaveError] = useState("");
  const initialState = useMemo(() => buildInitialSkillState(props), [props]);
  const [skillName, setSkillName] = useState(initialState.name);
  const [skillDescription, setSkillDescription] = useState(initialState.description);
  const [bodyValue, setBodyValue] = useState(initialState.body);
  const previewCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shareUrl = props.shareUrl || "";
  const openInAppUrl = props.openInAppDeepLink || "#";
  const openInWebUrl = props.openInWebAppUrl || "#";
  const title = props.title || "OpenWork bundle";
  const description = props.description || "OpenWork bundle ready to import.";
  const canEdit = props.bundleType === "skill";
  const resolvedName = resolveSkillName(skillName, bodyValue);
  const resolvedDescription = skillDescription.trim() || DEFAULT_SKILL_DESCRIPTION;
  const generatedSkillMarkdown = useMemo(
    () => composeSkillMarkdown(skillName, skillDescription, bodyValue),
    [bodyValue, skillDescription, skillName],
  );
  const previewText = canEdit ? generatedSkillMarkdown : props.previewText || "";
  const previewToneClass = props.previewTone ? toneClass({ tone: props.previewTone }) : "dot-skill";
  const saveDisabled = !canEdit || saveState === "saving" || !resolvedDescription || !bodyValue.trim();
  const compactItems: PreviewItem[] = props.items?.length
    ? props.items
    : [{ name: "skill.md", kind: "Skill", meta: "Skill bundle", tone: "skill" }];

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
    if (!previewText) return;

    try {
      await navigator.clipboard.writeText(previewText);
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

  const saveChanges = async () => {
    if (saveDisabled) return;

    setSaveState("saving");
    setSaveError("");

    try {
      const response = await fetch("/v1/bundles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "skill",
          name: resolvedName,
          description: resolvedDescription,
          content: generatedSkillMarkdown,
        }),
      });

      const result = (await response.json().catch(() => null)) as { url?: string; message?: string } | null;
      if (!response.ok) {
        throw new Error(result?.message || "Could not save changes.");
      }

      if (result?.url) {
        window.location.assign(result.url);
        return;
      }

      throw new Error("Could not save changes.");
    } catch (error) {
      setSaveState("failed");
      setSaveError(error instanceof Error ? error.message : "Could not save changes.");
    }
  };

  const headerActions = canEdit ? (
    <div className="skill-editor-inline-actions">
      {saveError ? <span className="save-status is-error">{saveError}</span> : null}
      <button className="button-secondary skill-save-button" type="button" onClick={() => void saveChanges()} disabled={saveDisabled}>
        {saveState === "saving" ? "Saving..." : "Save changes"}
      </button>
    </div>
  ) : null;

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
                <div className="button-row">
                  <a className="button-primary" href={openInAppUrl}>
                    Open in app
                  </a>
                  <a className="button-secondary" href={openInWebUrl} target="_blank" rel="noreferrer">
                    Open in web app
                  </a>
                  <button className="button-secondary" type="button" onClick={() => void copyShareUrl()}>
                    {copyState === "copied" ? "Copied!" : "Copy share link"}
                  </button>
                </div>
              </div>
            </section>

            <section className="share-bundle-stack">
              <article className="bundle-compact-strip surface-soft">
                <div className="bundle-strip-list" aria-label="Package contents">
                  {compactItems.map((item) => (
                    <span className="bundle-strip-chip" key={`${item.kind}-${item.name}`}>
                      <span className={`preview-filename-dot ${toneClass(item)}`} />
                      {compactItemLabel(props, item)}
                    </span>
                  ))}
                </div>
              </article>

              <SkillEditorSurface
                className="share-bundle-editor"
                toneClassName={previewToneClass}
                filename="skill.md"
                skillName={skillName}
                skillDescription={skillDescription}
                bodyValue={canEdit ? bodyValue : props.previewText || ""}
                metadataMode={canEdit ? "editable" : "readonly"}
                copied={previewCopied}
                onCopy={() => void copyPreview()}
                onSkillNameChange={(value) => {
                  setSkillName(value);
                  if (saveState === "failed") setSaveState("ready");
                  if (saveError) setSaveError("");
                }}
                onSkillDescriptionChange={(value) => {
                  setSkillDescription(value);
                  if (saveState === "failed") setSaveState("ready");
                  if (saveError) setSaveError("");
                }}
                onBodyChange={(value) => {
                  if (!canEdit) return;
                  setBodyValue(value);
                  if (saveState === "failed") setSaveState("ready");
                  if (saveError) setSaveError("");
                }}
                headerActions={headerActions}
              />

              <article className="result-card share-install-card">
                <span className="eyebrow">Open it in OpenWork</span>
                <div className="share-inline-steps">
                  {INSTALL_STEPS.map((step, index) => (
                    <div className="share-inline-step" key={step}>
                      <span className="step-bullet">{`0${index + 1}`}</span>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          </>
        )}
      </main>
    </>
  );
}
