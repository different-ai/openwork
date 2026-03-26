"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CheckCheck, CircleAlert, Layers3, MessageSquareMore, Sparkles } from "lucide-react";

const comparisonTheme = {
  ink: "#0f172a",
  muted: "#475569",
  caption: "#64748b",
  border: "rgba(148, 163, 184, 0.18)",
  card: "rgba(255, 255, 255, 0.94)",
  agentGrad: "linear-gradient(135deg, #1d4ed8, #60a5fa)",
  danger: "#ffe4e6",
  dangerText: "#9f1239",
  attention: "#fef3c7",
  attentionText: "#92400e",
  success: "#dcfce7",
  successText: "#166534",
  ease: "cubic-bezier(0.31, 0.325, 0, 0.92)",
} as const;

const comparisonTasks = [
  "PR #247",
  "INV #1092",
  "ISSUE #8",
  "QA notes",
  "Refund queue",
  "SLA digest",
  "Follow-ups",
];

const totalTicks = 110;

export function DenComparisonAnimation() {
  const [tick, setTick] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) {
      setTick(65);
      return;
    }

    const timer = window.setInterval(() => {
      setTick(current => (current >= totalTicks ? 0 : current + 1));
    }, 100);

    return () => window.clearInterval(timer);
  }, [reduceMotion]);

  const getDenTaskStyle = (index: number): CSSProperties => {
    const start = 8 + index * 14;
    const processing = start + 5;
    const done = start + 11;

    if (tick < start) return { left: "15%", top: `${20 + index * 10}%`, opacity: 0, transition: "none" };
    if (tick >= start && tick < processing) {
      return { left: "48%", top: "50%", opacity: 1, transition: `all 0.45s ${comparisonTheme.ease}` };
    }
    if (tick >= processing && tick < done) {
      return {
        left: "48%",
        top: "50%",
        opacity: 1,
        transform: "translate(-50%, -50%) scale(1.04)",
        transition: "all 0.8s linear",
      };
    }

    return {
      left: "82%",
      top: `${28 + Math.min(index, 3) * 6}%`,
      opacity: 0,
      transform: "translate(-50%, -50%) scale(0.88)",
      transition: `all 0.45s ${comparisonTheme.ease}, opacity 0.3s ease`,
    };
  };

  const getLocalTaskStyle = (index: number): CSSProperties => {
    if (index === 0) {
      if (tick < 6) return { left: "15%", top: "24%", opacity: 0, transition: "none" };
      if (tick >= 6 && tick < 12) {
        return { left: "48%", top: "50%", opacity: 1, transition: `all 0.45s ${comparisonTheme.ease}` };
      }
      if (tick >= 12 && tick < 46) return { left: "48%", top: "50%", opacity: 1, transition: "none" };
      if (tick >= 46 && tick < 56) {
        return {
          left: "82%",
          top: "28%",
          opacity: 0,
          transition: `all 0.45s ${comparisonTheme.ease}, opacity 0.35s ease`,
        };
      }

      return { left: "82%", top: "28%", opacity: 0, transition: "none" };
    }

    if (index === 1) {
      if (tick < 52) return { left: "15%", top: "34%", opacity: 0, transition: "none" };
      if (tick >= 52 && tick < 58) {
        return { left: "48%", top: "50%", opacity: 1, transition: `all 0.45s ${comparisonTheme.ease}` };
      }
      if (tick >= 58 && tick < totalTicks - 8) {
        return {
          left: "48%",
          top: "50%",
          opacity: 1,
          transform: tick >= 68 && tick < 74 ? "translate(-50%, -50%) translateX(3px)" : "translate(-50%, -50%)",
          transition: "all 0.12s ease",
        };
      }

      return { left: "48%", top: "50%", opacity: 0, transition: "none" };
    }

    return { left: "15%", top: `${24 + index * 10}%`, opacity: 0, transition: "none" };
  };

  const manualSolvedCount = tick < 50 ? 0 : 1;
  const denSolvedCount = reduceMotion ? 5 : tick < 20 ? 0 : tick < 34 ? 1 : tick < 48 ? 2 : tick < 62 ? 3 : tick < 76 ? 4 : 5;
  const isDenProcessing = tick >= 8 && tick < 86;
  const manualBacklogCount = tick < 50 ? 6 : 5;
  const denBacklogCount = Math.max(0, 6 - denSolvedCount);
  const manualFailed = tick >= 68;

  const getLocalStatus = () => {
    if (tick < 10) return { text: "IDLE", bg: "#f8fafc", color: comparisonTheme.caption };
    if (tick >= 10 && tick < 40) {
      return { text: "NEEDS APPROVAL", bg: comparisonTheme.attention, color: comparisonTheme.attentionText };
    }
    if (tick >= 40 && tick < 50) {
      return { text: "PROCESSING", bg: comparisonTheme.success, color: comparisonTheme.successText };
    }
    if (tick >= 50 && tick < 65) return { text: "GENERATING...", bg: "#e0e7ff", color: "#3730a3" };
    return { text: "CONTEXT FAILED", bg: comparisonTheme.danger, color: comparisonTheme.dangerText };
  };

  const localStatus = getLocalStatus();

  const renderBacklogStack = (items: string[], tone: "manual" | "den", activeCount: number) =>
    items.slice(0, activeCount).map((task, index) => (
      <div
        key={`${tone}-backlog-${task}`}
        style={{
          position: "absolute",
          left: `${8 + index * 1.2}%`,
          top: `${18 + index * 8}%`,
          width: "92px",
          borderRadius: "16px",
          background: "rgba(255,255,255,0.92)",
          border: `1px solid ${tone === "manual" ? "rgba(203, 213, 225, 0.9)" : "rgba(96, 165, 250, 0.26)"}`,
          boxShadow: "0 14px 30px -26px rgba(15, 23, 42, 0.22)",
          padding: "8px 10px",
          zIndex: index + 1,
          opacity: 1 - index * 0.08,
        }}
      >
        <div style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: tone === "manual" ? "#64748b" : "#1d4ed8", marginBottom: "4px" }}>
          {tone === "manual" ? "Queued" : "Incoming"}
        </div>
        <div style={{ fontSize: "11px", lineHeight: 1.35, fontFamily: "var(--font-mono)", color: "#334155" }}>
          {task}
        </div>
      </div>
    ));

  const renderSolvedStack = (items: string[], tone: "manual" | "den", statusLabel: string) =>
    items.map((task, index) => (
      <div
        key={`${tone}-solved-${task}`}
        style={{
          position: "absolute",
          right: `${8 + index * 1.6}%`,
          top: `${20 + index * 9}%`,
          width: "108px",
          borderRadius: "16px",
          background: tone === "manual" ? "rgba(255,255,255,0.94)" : "linear-gradient(180deg, rgba(255,255,255,0.96), rgba(239,244,255,0.96))",
          border: `1px solid ${tone === "manual" ? "rgba(203, 213, 225, 0.9)" : "rgba(27, 41, 255, 0.22)"}`,
          boxShadow: tone === "manual" ? "0 16px 34px -28px rgba(15,23,42,0.2)" : "0 18px 36px -28px rgba(27,41,255,0.28)",
          padding: "10px 12px",
          zIndex: items.length - index + 3,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
          {tone === "manual" ? <CheckCheck size={12} color="#166534" /> : <Sparkles size={12} color="#1b29ff" />}
          <span style={{ fontSize: "9px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: tone === "manual" ? "#166534" : "#1b29ff" }}>
            {statusLabel}
          </span>
        </div>
        <div style={{ fontSize: "11px", lineHeight: 1.35, fontFamily: "var(--font-mono)", color: "#1e293b" }}>
          {task}
        </div>
      </div>
    ));

  return (
    <div style={{ width: "100%", maxWidth: "860px", margin: "0 auto", background: comparisonTheme.card, border: `1px solid ${comparisonTheme.border}`, borderRadius: "2.25rem", overflow: "hidden", boxShadow: "0 28px 70px -34px rgba(15, 23, 42, 0.18)", backdropFilter: "blur(14px)", fontFamily: "var(--font-sans)" }}>
      <style>{`
        @keyframes ow-blob-pulse {
          0%, 100% { transform: scale(1); opacity: 0.5; }
          50% { transform: scale(1.4); opacity: 0.8; }
        }
        .ow-status-pill {
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          transition: all 0.3s ${comparisonTheme.ease};
        }
        .ow-task-chip {
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          background: rgba(255, 255, 255, 0.94);
          border: 1px solid #cbd5e1;
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 10px;
          font-family: var(--font-mono);
          font-weight: 600;
          color: #334155;
          box-shadow: 0 12px 28px -24px rgba(15,23,42,0.22);
          z-index: 10;
          white-space: nowrap;
        }
      `}</style>
      <div style={{ padding: "28px 32px", borderBottom: `1px solid ${comparisonTheme.border}`, position: "relative", background: "linear-gradient(180deg, rgba(255,255,255,0.78), rgba(248,250,252,0.94))" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", marginBottom: "22px", alignItems: "flex-start" }}>
          <div>
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: comparisonTheme.ink, margin: 0, letterSpacing: "-0.02em" }}>
              Chat-based / Local AI
            </h3>
            <p style={{ fontSize: "13px", color: comparisonTheme.muted, margin: "4px 0 0" }}>You are the bottleneck.</p>
          </div>
          <span className="ow-status-pill" style={{ background: localStatus.bg, color: localStatus.color }}>
            {localStatus.text}
          </span>
        </div>
        <div style={{ position: "relative", height: "160px" }}>
          <div style={{ position: "absolute", top: "50%", left: "17%", right: "18%", height: "2px", background: "repeating-linear-gradient(90deg, #cbd5e1 0, #cbd5e1 4px, transparent 4px, transparent 8px)", transform: "translateY(-50%)" }} />
          <div style={{ position: "absolute", left: "4%", top: "14%", fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#94a3b8" }}>Backlog</div>
          <div style={{ position: "absolute", right: "4%", top: "14%", fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#94a3b8" }}>Resolved</div>
          {renderBacklogStack(comparisonTasks, "manual", manualBacklogCount)}
          <div style={{ position: "absolute", top: "50%", left: "48%", transform: "translate(-50%, -50%)", width: "66px", height: "54px", background: "rgba(248, 250, 252, 0.92)", border: "1px solid rgba(203, 213, 225, 0.95)", borderRadius: "18px", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 18px 38px -30px rgba(15,23,42,0.24)", transition: `all 0.3s ${comparisonTheme.ease}`, borderColor: tick >= 65 ? comparisonTheme.dangerText : "#cbd5e1" }}>
            <MessageSquareMore size={22} color="#475569" />
          </div>
          <div style={{ position: "absolute", top: "50%", left: "48%", zIndex: 20, transform: `translate(${tick >= 30 && tick < 45 ? "10px, 10px" : "40px, 40px"})`, opacity: tick >= 25 && tick < 45 ? 1 : 0, transition: `all 0.6s ${comparisonTheme.ease}` }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M5.5 3.21V20.8L11.5 15.25L15 22L17.5 20.5L14 14H21L5.5 3.21Z" fill="#0f172a" stroke="white" strokeWidth="2" strokeLinejoin="round" />
            </svg>
            {tick >= 35 && tick < 40 ? (
              <span style={{ position: "absolute", top: -8, left: 16, background: comparisonTheme.ink, color: "#fff", fontSize: "9px", padding: "2px 6px", borderRadius: "4px", fontWeight: 600 }}>
                Click to Approve
              </span>
            ) : null}
          </div>
          {comparisonTasks.slice(0, 3).map((task, index) => (
            <div key={`local-${task}`} className="ow-task-chip" style={getLocalTaskStyle(index)}>
              {task}
            </div>
          ))}
          {renderSolvedStack(comparisonTasks.slice(0, manualSolvedCount), "manual", "done")}
          {manualFailed ? (
            <div style={{ position: "absolute", left: "56%", top: "67%", display: "inline-flex", alignItems: "center", gap: "6px", borderRadius: "999px", background: "#ffe4e6", color: "#9f1239", padding: "6px 10px", fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              <CircleAlert size={12} />
              Context failed
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ padding: "28px 32px", background: "linear-gradient(180deg, rgba(252,253,253,0.98), rgba(245,248,255,0.98))" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", marginBottom: "22px", alignItems: "flex-start" }}>
          <div>
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: comparisonTheme.ink, margin: 0, letterSpacing: "-0.02em" }}>
              Always-on Cloud Worker
            </h3>
            <p style={{ fontSize: "13px", color: comparisonTheme.muted, margin: "4px 0 0" }}>Autonomous, sandboxed execution.</p>
          </div>
          <span className="ow-status-pill" style={{ background: isDenProcessing ? "rgba(27,41,255,0.1)" : comparisonTheme.success, color: isDenProcessing ? "#1b29ff" : comparisonTheme.successText }}>
            {isDenProcessing ? "PROCESSING QUEUE" : "LISTENING"}
          </span>
        </div>
        <div style={{ position: "relative", height: "160px" }}>
          <div style={{ position: "absolute", top: "50%", left: "17%", right: "18%", height: "2px", background: "linear-gradient(90deg, rgba(148,163,184,0.35), rgba(27,41,255,0.22))", transform: "translateY(-50%)" }} />
          <div style={{ position: "absolute", left: "4%", top: "14%", fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#94a3b8" }}>Queue</div>
          <div style={{ position: "absolute", right: "4%", top: "14%", fontSize: "10px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#94a3b8" }}>Solved stack</div>
          {renderBacklogStack(comparisonTasks.slice(denSolvedCount, denSolvedCount + denBacklogCount), "den", denBacklogCount)}
          <div style={{ position: "absolute", top: "50%", left: "48%", transform: "translate(-50%, -50%)", width: "56px", height: "56px", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ position: "absolute", inset: "-8px", borderRadius: "18px", background: comparisonTheme.agentGrad, filter: "blur(8px)", animation: "ow-blob-pulse 2s infinite ease-in-out", opacity: isDenProcessing ? 1 : 0, transition: "opacity 0.3s" }} />
            <div style={{ position: "absolute", inset: 0, borderRadius: "18px", background: "rgba(255,255,255,0.96)", border: "1px solid rgba(27,41,255,0.2)", zIndex: 2, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(27,41,255,0.15)" }}>
              <Layers3 size={20} color="#1b29ff" />
            </div>
          </div>
          {comparisonTasks.slice(0, 5).map((task, index) => (
            <div
              key={`den-${task}`}
              className="ow-task-chip"
              style={{ ...getDenTaskStyle(index), borderColor: tick > 5 + index * 25 + 5 ? "#1b29ff" : "#cbd5e1", color: tick > 5 + index * 25 + 5 ? "#1b29ff" : "#334155" }}
            >
              {task}
            </div>
          ))}
          {renderSolvedStack(comparisonTasks.slice(0, denSolvedCount), "den", "sent")}
        </div>
      </div>
    </div>
  );
}
