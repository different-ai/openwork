"use client";

import { useMemo, type ReactNode } from "react";

import { highlightSyntax } from "./share-preview-syntax";
import { DEFAULT_SKILL_NAME } from "./skill-markdown";

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
  eyebrow,
  filename,
  documentValue,
  documentPlaceholderPreview = "",
  readOnly = false,
  copied,
  onCopy,
  onDocumentChange,
  headerActions,
}: {
  className?: string;
  toneClassName?: string;
  eyebrow?: string;
  filename?: string;
  documentValue: string;
  documentPlaceholderPreview?: string;
  readOnly?: boolean;
  copied: boolean;
  onCopy: () => void;
  onDocumentChange?: (value: string) => void;
  headerActions?: ReactNode;
}) {
  const displayDocument = documentValue || documentPlaceholderPreview;
  const highlightedDocument = useMemo(() => highlightSyntax(displayDocument), [displayDocument]);
  const rootClassName = ["preview-panel", className].filter(Boolean).join(" ");

  return (
    <aside className={rootClassName}>
      <div className="preview-surface">
        <div className="preview-header">
          <span className="preview-eyebrow">{eyebrow || "Preview"}</span>
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

        <div className="preview-editor-wrap">
          <pre
            className="preview-highlight"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: `${highlightedDocument}\n` }}
          />
          {readOnly ? null : (
            <textarea
              className="preview-editor"
              value={documentValue}
              onChange={(event) => onDocumentChange?.(event.target.value)}
              placeholder=""
              spellCheck={false}
            />
          )}
        </div>

        <div className="preview-footer">
          <span>{countLabel(documentValue || displayDocument)}</span>
        </div>
      </div>
    </aside>
  );
}
