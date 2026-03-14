"use client";

import { useMemo, type ReactNode } from "react";

import { highlightSyntax } from "./share-preview-syntax";
import { DEFAULT_SKILL_DESCRIPTION, DEFAULT_SKILL_NAME, yamlValue } from "./skill-markdown";

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

export default function SkillEditorSurface({
  className,
  toneClassName,
  filename,
  skillName,
  skillDescription,
  bodyValue,
  bodyPlaceholderPreview = "",
  metadataMode = "readonly",
  readOnly = false,
  copied,
  onCopy,
  onSkillNameChange,
  onSkillDescriptionChange,
  onBodyChange,
  headerActions,
}: {
  className?: string;
  toneClassName?: string;
  filename?: string;
  skillName: string;
  skillDescription: string;
  bodyValue: string;
  bodyPlaceholderPreview?: string;
  metadataMode?: "readonly" | "editable";
  readOnly?: boolean;
  copied: boolean;
  onCopy: () => void;
  onSkillNameChange?: (value: string) => void;
  onSkillDescriptionChange?: (value: string) => void;
  onBodyChange?: (value: string) => void;
  headerActions?: ReactNode;
}) {
  const displayBody = bodyValue || bodyPlaceholderPreview;
  const highlightedBody = useMemo(() => highlightSyntax(displayBody), [displayBody]);
  const rootClassName = ["preview-panel", className].filter(Boolean).join(" ");

  return (
    <aside className={rootClassName}>
      <div className="preview-surface">
        <div className="preview-header">
          <span className="preview-eyebrow">Preview</span>
          <div className="preview-header-actions">
            {headerActions}
            <span className="preview-filename">
              <span className={`preview-filename-dot ${toneClassName || "dot-skill"}`} />
              {filename || DEFAULT_SKILL_NAME}
              <button
                type="button"
                className="clipboard-egg-button preview-copy-button clipboard-egg-inline"
                title="Copy preview"
                aria-label="Copy preview"
                onClick={onCopy}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </button>
            </span>
          </div>
        </div>

        {metadataMode === "editable" ? (
          <div className="share-frontmatter-editor">
            <div className="share-metadata-grid">
              <label className="share-metadata-field">
                <span className="share-metadata-key">name:</span>
                <input
                  aria-label="Skill name"
                  className="share-metadata-input mono"
                  value={skillName}
                  onChange={(event) => onSkillNameChange?.(event.target.value)}
                />
              </label>

              <label className="share-metadata-field">
                <span className="share-metadata-key">description:</span>
                <input
                  aria-label="Skill description"
                  className="share-metadata-input"
                  value={skillDescription}
                  onChange={(event) => onSkillDescriptionChange?.(event.target.value)}
                />
              </label>
            </div>
          </div>
        ) : (
          <div className="share-frontmatter-preview mono">
            <span>---</span>
            <span>name: {yamlValue(skillName || DEFAULT_SKILL_NAME)}</span>
            <span>description: {yamlValue(skillDescription || DEFAULT_SKILL_DESCRIPTION)}</span>
            <span>---</span>
          </div>
        )}

        <div className="preview-editor-wrap">
          <pre
            className="preview-highlight"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: `${highlightedBody}\n` }}
          />
          {readOnly ? null : (
            <textarea
              className="preview-editor"
              value={bodyValue}
              onChange={(event) => onBodyChange?.(event.target.value)}
              placeholder=""
              spellCheck={false}
            />
          )}
        </div>

        <div className="preview-footer">
          <span>{countLabel(bodyValue)}</span>
        </div>
      </div>
    </aside>
  );
}
