import { ImageResponse } from "next/og";
import type { CSSProperties, ReactElement } from "react";

import type { OgImageModel, OgTokenClass } from "./render-og-image.ts";

const canvasStyle: CSSProperties = {
  width: "1200px",
  height: "630px",
  position: "relative",
  display: "flex",
  background: "#f6f9fc",
  overflow: "hidden",
};

const monoStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: "15px",
  lineHeight: "22px",
  color: "#475569",
};

const sansStyle: CSSProperties = {
  fontFamily: "sans-serif",
  color: "#0f172a",
};

function circleStyle(options: {
  left?: number;
  right?: number;
  top: number;
  size: number;
  background: string;
  opacity?: number;
}): CSSProperties {
  const style: CSSProperties = {
    position: "absolute",
    top: `${options.top}px`,
    width: `${options.size}px`,
    height: `${options.size}px`,
    borderRadius: "999px",
    background: options.background,
    opacity: options.opacity ?? 1,
  };

  if (options.left != null) style.left = `${options.left}px`;
  if (options.right != null) style.right = `${options.right}px`;

  return style;
}

function segmentStyle(className: OgTokenClass): CSSProperties {
  switch (className) {
    case "hl-frontmatter":
      return { color: "#94a3b8" };
    case "hl-key":
      return { color: "#475569" };
    case "hl-url":
      return { color: "#2563eb" };
    case "hl-string":
      return { color: "#0f766e" };
    case "hl-bracket":
      return { color: "#94a3b8" };
    case "hl-punctuation":
      return { color: "#94a3b8" };
    case "hl-number":
      return { color: "#f97316" };
    case "hl-keyword":
      return { color: "#be123c" };
    case "hl-comment":
      return { color: "#94a3b8", fontStyle: "italic" };
    case "hl-heading":
      return { color: "#0f172a", fontWeight: 700 };
    case "hl-field":
      return { color: "#be123c" };
    case "hl-inline-code":
      return { color: "#7c3aed" };
    case "hl-bold":
      return { color: "#0f172a", fontWeight: 700 };
    case "hl-type":
      return { color: "#0ea5e9", fontStyle: "italic" };
    case "hl-cta":
      return { color: "#0f172a" };
    case "hl-cta-skill":
      return { color: "#0f172a", fontWeight: 700 };
    case "hl-cta-url":
      return { color: "#0f172a", fontWeight: 700, textDecoration: "underline" };
    case "hl-codeblock":
      return {
        color: "#F99D16",
        background: "#f8fafc",
        border: "1px solid #cbd5e1",
        borderRadius: "5px",
        paddingRight: "6px",
      };
    default:
      return { color: "#475569" };
  }
}

function OgImage({ model }: { model: OgImageModel }): ReactElement {
  return (
    <div style={canvasStyle}>
      <div style={circleStyle({ left: -42, top: -90, size: 420, background: "#F99D16", opacity: 0.22 })} />
      <div style={circleStyle({ right: -46, top: -92, size: 400, background: "#111827", opacity: 0.09 })} />
      <div
        style={{
          position: "absolute",
          left: "48px",
          top: "44px",
          width: "1104px",
          height: "542px",
          borderRadius: "42px",
          background: "rgba(255,255,255,0.72)",
          border: "1px solid rgba(255,255,255,0.9)",
          boxShadow: "0 36px 56px rgba(15, 23, 42, 0.14)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "18px",
          top: "12px",
          width: "1164px",
          height: "606px",
          borderRadius: "38px",
          background: "rgba(255,255,255,0.96)",
          border: "1px solid rgba(148,163,184,0.16)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "66px",
            borderBottom: "1px solid rgba(226,232,240,0.92)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 34px",
          }}
        >
          <div style={{ ...sansStyle, fontSize: "28px", fontWeight: 800, letterSpacing: "-1.2px" }}>SKILL.md</div>
          <div style={{ display: "flex", alignItems: "center", gap: "13px" }}>
            <div
              style={{
                width: "14px",
                height: "14px",
                borderRadius: "999px",
                background: "linear-gradient(135deg, #f97316 0%, #facc15 100%)",
              }}
            />
            <div style={{ ...monoStyle, fontSize: "16px", color: "#94a3b8" }}>{model.filename}</div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "50px 34px 0 34px",
            gap: "0px",
            ...monoStyle,
          }}
        >
          {model.lines.map((line, index) => (
            <div key={index} style={{ display: "flex", minHeight: "22px", alignItems: "baseline" }}>
              <div
                style={{
                  width: "44px",
                  color: "#cbd5e1",
                  fontSize: "13px",
                  fontWeight: 600,
                  lineHeight: "22px",
                }}
              >
                {line.lineNumber == null ? "" : String(line.lineNumber).padStart(2, "0")}
              </div>
              <div style={{ display: "flex", whiteSpace: "pre", flexWrap: "nowrap" }}>
                {line.segments.length ? (
                  line.segments.map((segment, segmentIndex) => (
                    <span key={segmentIndex} style={segmentStyle(segment.className)}>
                      {segment.text}
                    </span>
                  ))
                ) : (
                  <span>{" "}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function renderOgPngResponse(model: OgImageModel, headers: Record<string, string> = {}): ImageResponse {
  const response = new ImageResponse(<OgImage model={model} />, {
    width: 1200,
    height: 630,
  });

  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }

  return response;
}
