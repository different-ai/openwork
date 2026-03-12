"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  Box,
  Cpu,
  GitPullRequest,
  MessageSquare,
  ShieldCheck,
  Wrench,
} from "lucide-react";

const capabilityItems = [
  { label: "Secure isolation", icon: ShieldCheck },
  { label: "Slack + Telegram", icon: MessageSquare },
  { label: "Custom MCP tools", icon: Wrench },
  { label: "Any LLM (BYOK)", icon: Cpu },
  { label: "Open source", icon: GitPullRequest },
  { label: "Persistent state", icon: Box },
];

export function DenCapabilityCarousel() {
  const reduceMotion = useReducedMotion();
  const repeatedItems = [...capabilityItems, ...capabilityItems];

  return (
    <section className="landing-shell overflow-hidden rounded-[2rem] py-7 md:py-8">
      <div className="mb-6 px-7 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500 md:px-8">
        What you get
      </div>

      <div className="relative overflow-hidden">
        <motion.div
          className="flex w-max gap-3 px-7 md:gap-4 md:px-8"
          animate={reduceMotion ? undefined : { x: ["0%", "-50%"] }}
          transition={
            reduceMotion
              ? undefined
              : { duration: 24, ease: "linear", repeat: Infinity }
          }
        >
          {repeatedItems.map((item, index) => {
            const Icon = item.icon;

            return (
              <div
                key={`${item.label}-${index}`}
                className="flex min-w-[260px] items-center gap-4 rounded-[1.5rem] border border-slate-200/70 bg-white/75 px-5 py-5 text-slate-700 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.18)]"
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-slate-100 bg-white text-[#1b29ff] shadow-sm">
                  <Icon size={18} strokeWidth={2.2} />
                </span>
                <span className="text-[1.1rem] font-medium tracking-tight text-[#011627]">
                  {item.label}
                </span>
              </div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
