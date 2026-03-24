import { ImageResponse } from "next/og";

export const alt = "Den Cloud Workers";
export const size = {
  width: 1200,
  height: 630
};

export const contentType = "image/png";

function StatusDot(props: { color: string }) {
  return (
    <div
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: props.color
      }}
    />
  );
}

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: "linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)",
          color: "#011627",
          fontFamily: "Inter, sans-serif"
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(circle at top left, rgba(15, 23, 42, 0.08), transparent 30%), radial-gradient(circle at right center, rgba(79, 109, 255, 0.12), transparent 24%)"
          }}
        />

        <div
          style={{
            display: "flex",
            width: "100%",
            justifyContent: "space-between",
            padding: "56px 60px",
            gap: 32,
            position: "relative"
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", width: 580, gap: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 18,
                  background: "#011627",
                  color: "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  fontWeight: 700
                }}
              >
                OW
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: 3, color: "#64748b" }}>
                  OpenWork hosted
                </div>
                <div style={{ fontSize: 24, fontWeight: 600 }}>Den Cloud Workers</div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 64, fontWeight: 600, letterSpacing: -2.8, lineHeight: 0.98 }}>
              <div>Always-on AI workers</div>
              <div>for you and your team.</div>
            </div>

            <div style={{ fontSize: 24, lineHeight: 1.45, color: "#475569", display: "flex", maxWidth: 520 }}>
              Launch cloud workers, manage Polar checkout, and operate Den directly from app.openworklabs.com.
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {[
                "Open source",
                "50+ integrations and LLMs",
                "Free first worker",
                "Polar billing for scale"
              ].map((label) => (
                <div
                  key={label}
                  style={{
                    display: "flex",
                    padding: "12px 18px",
                    borderRadius: 999,
                    border: "1px solid rgba(148, 163, 184, 0.35)",
                    background: "rgba(255, 255, 255, 0.82)",
                    fontSize: 16,
                    fontWeight: 600,
                    color: "#334155"
                  }}
                >
                  {label}
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              width: 430,
              display: "flex",
              flexDirection: "column",
              borderRadius: 28,
              overflow: "hidden",
              background: "#151718",
              boxShadow: "0 32px 90px -45px rgba(15, 23, 42, 0.75)",
              border: "1px solid rgba(255,255,255,0.65)"
            }}
          >
            <div
              style={{
                height: 54,
                display: "flex",
                alignItems: "center",
                padding: "0 20px",
                position: "relative",
                background: "#1d1f21",
                borderBottom: "1px solid rgba(255,255,255,0.08)"
              }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <StatusDot color="#ff5f56" />
                <StatusDot color="#ffbd2e" />
                <StatusDot color="#27c93f" />
              </div>
              <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", color: "#94a3b8", fontSize: 14, letterSpacing: 2, textTransform: "uppercase" }}>
                ops-worker-01
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: 22, color: "white" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#94a3b8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 2.5 }}>
                <div style={{ width: 10, height: 10, borderRadius: 999, background: "#3ddc97", boxShadow: "0 0 0 8px rgba(61, 220, 151, 0.14)" }} />
                Running
              </div>

              {[
                ["9:41 AM", "GitHub", "Reviewed PR #247, approved"],
                ["10:12 AM", "Slack", "Flagged invoice #1092 as duplicate"],
                ["1:30 PM", "Linear", "Triaged 8 issues, 2 critical"],
                ["3:15 PM", "Polar", "Checkout return ready for launch"]
              ].map(([time, source, detail]) => (
                <div
                  key={`${time}-${source}`}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: "14px 16px",
                    borderRadius: 18,
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.08)"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#94a3b8" }}>{time}</div>
                    <div style={{ padding: "4px 8px", borderRadius: 999, background: "rgba(255,255,255,0.07)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "#cbd5e1" }}>
                      {source}
                    </div>
                  </div>
                  <div style={{ fontSize: 18, lineHeight: 1.45, color: "#f8fafc" }}>{detail}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    ),
    size
  );
}
