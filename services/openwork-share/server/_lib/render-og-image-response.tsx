import { ImageResponse } from "next/og";
import type { CSSProperties, ReactElement } from "react";

import { computeOgImageLayout, type OgImageModel } from "./render-og-image.ts";

const canvasStyle: CSSProperties = {
  width: "1200px",
  height: "630px",
  position: "relative",
  display: "flex",
  overflow: "hidden",
  background: "linear-gradient(135deg, #f6f9fc 0%, #edf1f7 32%, #e2e8f0 66%, #f6f9fc 100%)",
};

const brandTextStyle: CSSProperties = {
  fontFamily: "sans-serif",
  fontSize: "22px",
  fontWeight: 600,
  color: "#334155",
};

const monoStyle: CSSProperties = {
  fontFamily: "monospace",
  color: "#64748b",
};

function OpenWorkMark(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="6" fill="#011627" />
      <circle cx="8" cy="8" r="2.5" fill="#f6f9fc" />
      <circle cx="16" cy="8" r="2.5" fill="#f6f9fc" />
      <circle cx="8" cy="16" r="2.5" fill="#f6f9fc" />
      <circle cx="16" cy="16" r="2.5" fill="#f6f9fc" />
    </svg>
  );
}

function OgImage({ model }: { model: OgImageModel }): ReactElement {
  const layout = computeOgImageLayout(model);

  return (
    <div style={canvasStyle}>
      <div
        style={{
          position: "absolute",
          inset: "-18%",
          transform: "rotate(-18deg)",
          background:
            "linear-gradient(90deg, rgba(255,255,255,0) 26%, rgba(148,163,184,0.08) 45%, rgba(203,213,225,0.14) 50%, rgba(148,163,184,0.08) 55%, rgba(255,255,255,0) 74%)",
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: "0",
          opacity: 0.6,
          backgroundImage:
            "radial-gradient(circle at 3px 3px, rgba(148,163,184,0.16) 1.2px, transparent 1.2px)",
          backgroundSize: "32px 32px",
        }}
      />

      <div
        style={{
          position: "absolute",
          top: "30px",
          left: "58px",
          display: "flex",
          alignItems: "center",
          gap: "10px",
        }}
      >
        <OpenWorkMark />
        <span style={brandTextStyle}>openwork</span>
      </div>

      <div
        style={{
          position: "absolute",
          right: "58px",
          bottom: "32px",
          ...monoStyle,
          fontSize: "14px",
        }}
      >
        {model.domain}
      </div>

      <div
        style={{
          position: "absolute",
          left: "108px",
          top: "82px",
          width: "984px",
          height: "466px",
          borderRadius: "28px",
          background: "rgba(255,255,255,0.72)",
          border: "1px solid rgba(226,232,240,0.85)",
          boxShadow: "0 18px 40px rgba(1,22,39,0.08), 0 4px 12px rgba(1,22,39,0.04)",
          display: "flex",
          flexDirection: "column",
          padding: "44px 72px 42px 72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ ...monoStyle, fontSize: "18px" }}>{model.fileName}</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              height: "34px",
              padding: "0 16px",
              borderRadius: "999px",
              background: "rgba(255,255,255,0.82)",
              border: "1px solid rgba(226,232,240,0.72)",
            }}
          >
            <div
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "999px",
                background: "#011627",
              }}
            />
            <span style={{ ...monoStyle, fontSize: "15px", color: "#334155" }}>{model.fileType}</span>
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            maxWidth: "720px",
          }}
        >
          {layout.titleLines.map((line, index) => (
            <div
              key={`${line}-${index}`}
              style={{
                fontFamily: "sans-serif",
                fontSize: `${layout.titleFontSize}px`,
                lineHeight: `${layout.titleLineHeight}px`,
                fontWeight: 700,
                letterSpacing: "-0.04em",
                color: "#011627",
              }}
            >
              {line}
            </div>
          ))}

          {layout.showDescription ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                marginTop: "18px",
                maxWidth: "620px",
              }}
            >
              {layout.descriptionLines.map((line, index) => (
                <div
                  key={`${line}-${index}`}
                  style={{
                    fontFamily: "sans-serif",
                    fontSize: "19px",
                    lineHeight: "24px",
                    fontWeight: 500,
                    color: "#475569",
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
          <span
            style={{
              ...monoStyle,
              fontSize: "15px",
              letterSpacing: "0.16em",
              color: "#64748b",
            }}
          >
            {model.category.toUpperCase()}
          </span>
          <span style={{ ...monoStyle, fontSize: "15px", color: "#cbd5e1" }}>/</span>
          <span style={{ ...monoStyle, fontSize: "15px" }}>{model.tag}</span>
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
