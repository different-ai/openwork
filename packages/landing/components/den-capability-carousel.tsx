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
    <section className="relative left-1/2 w-screen -translate-x-1/2 overflow-hidden py-3 md:py-4">
      <div className="content-max-width mb-5 px-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500 md:px-8">
        What you get
      </div>

      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-[#f6f9fc] via-[#f6f9fc]/90 to-transparent md:w-28" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-[#f6f9fc] via-[#f6f9fc]/90 to-transparent md:w-28" />
        <motion.div
          className="flex w-max items-center gap-8 px-6 md:gap-12 md:px-8"
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
                className="flex shrink-0 items-center gap-3 text-slate-700"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/55 text-[#1b29ff] shadow-[0_10px_24px_-20px_rgba(15,23,42,0.4)] ring-1 ring-white/70 backdrop-blur-sm">
                  <Icon size={17} strokeWidth={2.2} />
                </span>
                <span className="text-[1rem] font-medium tracking-tight text-[#011627] md:text-[1.08rem]">
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
