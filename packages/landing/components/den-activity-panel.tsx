"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

const baseActivityEntries = [
  {
    time: "9:41 AM",
    source: "GitHub",
    tone: "success" as const,
    lines: ["Reviewed PR #247, approved"],
  },
  {
    time: "10:12 AM",
    source: "Slack",
    tone: "warning" as const,
    lines: ["Flagged invoice #1092,", "duplicate"],
  },
  {
    time: "1:30 PM",
    source: "GitHub",
    tone: "critical" as const,
    lines: ["Triaged 8 issues, 2 critical"],
  },
  {
    time: "3:15 PM",
    source: "Slack",
    tone: "success" as const,
    lines: ["Weekly digest sent to #ops"],
  },
  {
    time: "5:44 PM",
    source: "Slack",
    tone: "success" as const,
    lines: ["6 follow-up emails queued", "for review"],
  },
  {
    time: "6:05 PM",
    source: "Linear",
    tone: "warning" as const,
    lines: ["Moved 3 stale tickets to backlog"],
  },
  {
    time: "8:20 AM",
    source: "Slack",
    tone: "success" as const,
    lines: ["Morning sync summary posted"],
  },
  {
    time: "11:45 AM",
    source: "GitHub",
    tone: "success" as const,
    lines: ["Merged dependabot PRs"],
  },
];

const toneStyles = {
  success: { bg: "bg-[#22c55e]", shadow: "0 0 0 7px rgba(34,197,94,0.18)" },
  warning: { bg: "bg-[#f59e0b]", shadow: "0 0 0 7px rgba(245,158,11,0.18)" },
  critical: { bg: "bg-[#ef4444]", shadow: "0 0 0 7px rgba(239,68,68,0.16)" },
} as const;

export function DenActivityPanel() {
  const reduceMotion = useReducedMotion();
  const [items, setItems] = useState(() =>
    baseActivityEntries.slice(0, 5).map((entry, i) => ({ ...entry, id: `initial-${i}` }))
  );
  const feedIndexRef = useRef(5);

  useEffect(() => {
    if (reduceMotion) return;

    const interval = setInterval(() => {
      const idx = feedIndexRef.current;
      feedIndexRef.current = idx + 1;

      const nextEntry = baseActivityEntries[idx % baseActivityEntries.length];
      const now = new Date();
      let hours = now.getHours();
      const minutes = now.getMinutes().toString().padStart(2, "0");
      const ampm = hours >= 12 ? "PM" : "AM";
      hours = hours % 12;
      hours = hours ? hours : 12;
      const timeString = `${hours}:${minutes} ${ampm}`;

      setItems(currentItems => {
        const newItems = [
          ...currentItems,
          {
            ...nextEntry,
            time: timeString,
            id: `item-${Date.now()}`,
          },
        ];

        return newItems.length > 5 ? newItems.slice(1) : newItems;
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [reduceMotion]);

  return (
    <div className="den-carbon-window w-full max-w-[372px] overflow-hidden rounded-[2rem] lg:ml-auto">
      <div className="den-carbon-titlebar relative flex items-center px-4 py-3">
        <div className="flex gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f56]" />
          <span className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <span className="h-3 w-3 rounded-full bg-[#27c93f]" />
        </div>
        <div className="absolute left-1/2 -translate-x-1/2 text-[12px] font-medium tracking-[0.08em] text-[#64748b]">
          ops-worker-01
        </div>
      </div>

      <div className="space-y-3.5 px-4 py-4 md:px-4 md:py-4">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#64748b]">
          <span className={`h-2 w-2 rounded-full bg-[#3ddc97] ${reduceMotion ? "" : "den-running-dot"}`} />
          RUNNING
        </div>

        <div className="relative space-y-3 pl-8 before:absolute before:bottom-2 before:left-[9px] before:top-1 before:w-px before:bg-[#cbd5e1] before:content-['']">
          <motion.div layout className="relative flex flex-col gap-3">
            {items.map(entry => (
              <motion.div
                layout
                key={entry.id}
                className="relative rounded-[1rem] bg-white/55 px-3 py-2.5 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.35)]"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.9, y: 15 }}
                animate={reduceMotion ? undefined : { opacity: 1, scale: 1, y: 0 }}
                transition={
                  reduceMotion
                    ? undefined
                    : { type: "spring", stiffness: 300, damping: 25, mass: 0.8 }
                }
              >
                <span
                  className={`absolute -left-8 top-[0.25rem] h-2.5 w-2.5 rounded-full ${toneStyles[entry.tone].bg}`}
                  style={{ boxShadow: toneStyles[entry.tone].shadow }}
                />
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="mono text-[11px] text-[#94a3b8]">{entry.time}</span>
                  <span className="den-source-pill">{entry.source}</span>
                </div>
                <div className="space-y-0.5 text-[12px] leading-[1.55] text-[#0f172a] md:text-[12.5px]">
                  {entry.lines.map(line => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
