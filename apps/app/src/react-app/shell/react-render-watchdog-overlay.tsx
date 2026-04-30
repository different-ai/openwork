/** @jsxImportSource react */
import { useEffect, useState } from "react";

import {
  readReactRenderWatchdogSnapshot,
  resetReactRenderWatchdogStats,
} from "./react-render-watchdog";

function readStoredPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("openwork.debug.renderOverlay") === "1";
  } catch {
    return false;
  }
}

function writeStoredPreference(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("openwork.debug.renderOverlay", value ? "1" : "0");
  } catch {
    // ignore
  }
}

export function ReactRenderWatchdogOverlay() {
  const [visible, setVisible] = useState(readStoredPreference);
  const [collapsed, setCollapsed] = useState(false);
  const [snapshot, setSnapshot] = useState(readReactRenderWatchdogSnapshot);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const metaOrCtrl = event.metaKey || event.ctrlKey;
      if (!metaOrCtrl || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "l") return;
      event.preventDefault();
      setVisible((current) => {
        writeStoredPreference(!current);
        return !current;
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const tick = () => setSnapshot(readReactRenderWatchdogSnapshot());
    tick();
    const interval = window.setInterval(tick, 500);
    return () => window.clearInterval(interval);
  }, [visible]);

  if (!visible) return null;

  const hot = snapshot.slice(0, 12);

  return (
    <div className="pointer-events-auto fixed bottom-3 left-3 z-[1100] w-[320px] overflow-hidden rounded-lg border border-dls-border bg-dls-canvas/95 text-[11px] text-dls-text shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-dls-border px-2.5 py-1.5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-dls-secondary">
            render watchdog
          </div>
          <div className="text-[10px] text-dls-secondary">
            hottest committed React surfaces
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-dls-secondary hover:bg-dls-hover"
            onClick={() => {
              resetReactRenderWatchdogStats();
              setSnapshot([]);
            }}
          >
            reset
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-dls-secondary hover:bg-dls-hover"
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "+" : "–"}
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-dls-secondary hover:bg-dls-hover"
            onClick={() => {
              writeStoredPreference(false);
              setVisible(false);
            }}
            title="Hide (Cmd+Shift+L to toggle)"
          >
            ×
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <div className="max-h-[50vh] overflow-y-auto">
          {hot.length === 0 ? (
            <div className="px-3 py-3 text-dls-secondary">
              No render samples yet. Interact with the app.
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.1em] text-dls-secondary">
                  <th className="px-2 py-1 text-left font-medium">surface</th>
                  <th className="px-2 py-1 text-right font-medium">2s</th>
                  <th className="px-2 py-1 text-right font-medium">total</th>
                  <th className="px-2 py-1 text-right font-medium">last</th>
                </tr>
              </thead>
              <tbody>
                {hot.map((item) => (
                  <tr key={item.name} className="border-t border-dls-border">
                    <td className="max-w-[160px] px-2 py-1 font-mono text-[11px] text-dls-text">
                      <span className="block truncate" title={item.name}>{item.name}</span>
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {item.windowCommits}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-dls-secondary">
                      {item.totalCommits}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-dls-secondary">
                      {Math.round(item.lastCommitAgeMs)}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="border-t border-dls-border px-2.5 py-1 text-[10px] text-dls-secondary">
        Cmd+Shift+L toggles. Also available in window.__openwork.slice("reactRenderWatchdog").
      </div>
    </div>
  );
}
