"use client";

import { motion } from "framer-motion";
import { Blocks, Box, MessageSquare, Shield } from "lucide-react";
import { AppleGlyph, SlackGlyph, TelegramGlyph, WindowsGlyph } from "./den-icons";

export function DenSupportGrid() {
  return (
    <section className="grid gap-6 md:grid-cols-2">
      <div className="landing-shell flex flex-col rounded-[2rem] p-6 md:p-8">
        <div className="landing-shell-soft mb-8 flex min-h-[200px] flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl p-6">
          <div className="relative flex items-center gap-4">
            <motion.div
              className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full bg-blue-400"
              style={{ y: "-50%" }}
              animate={{ x: [-40, 40], opacity: [0, 1, 1, 0] }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut",
                times: [0, 0.2, 0.8, 1],
              }}
            />
            <motion.div
              className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full bg-orange-400"
              style={{ y: "-50%" }}
              animate={{ x: [40, -40], opacity: [0, 1, 1, 0] }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut",
                times: [0, 0.2, 0.8, 1],
                delay: 1,
              }}
            />

            <motion.div
              className="group relative z-10 flex h-16 w-16 cursor-default items-center justify-center rounded-2xl border border-orange-200 bg-orange-100 shadow-inner"
              animate={{ y: [-2, 2, -2] }}
              transition={{
                duration: 4,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            >
              <Box size={28} className="text-orange-500 transition-transform group-hover:scale-110" />
              <div className="absolute -right-2 -top-2 rounded-full border border-gray-200 bg-white p-1 shadow-sm">
                <motion.div
                  className="h-2 w-2 rounded-full bg-green-500"
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ duration: 2, repeat: Infinity }}
                />
              </div>
            </motion.div>

            <div className="z-0 flex flex-col gap-2 opacity-50">
              <div className="h-1.5 w-16 rounded-full bg-gray-300" />
              <div className="h-1.5 w-16 rounded-full bg-gray-300" />
            </div>

            <motion.div
              className="group relative z-10 flex h-16 w-16 cursor-default items-center justify-center rounded-2xl border border-blue-200 bg-blue-100 shadow-inner"
              animate={{ y: [2, -2, 2] }}
              transition={{
                duration: 4,
                repeat: Infinity,
                ease: "easeInOut",
                delay: 0.5,
              }}
            >
              <Box size={28} className="text-blue-500 transition-transform group-hover:scale-110" />
              <div className="absolute -right-2 -top-2 rounded-full border border-gray-200 bg-white p-1 shadow-sm">
                <motion.div
                  className="h-2 w-2 rounded-full bg-green-500"
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ duration: 2, repeat: Infinity, delay: 1 }}
                />
              </div>
            </motion.div>
          </div>

          <motion.div
            className="mt-8 flex items-center gap-2 rounded-full border border-green-100 bg-green-50 px-3 py-1.5"
            whileHover={{ scale: 1.05 }}
          >
            <Shield size={12} className="text-green-600" />
            <span className="text-[11px] font-bold uppercase tracking-wide text-green-700">
              Isolated &amp; Secure
            </span>
          </motion.div>
        </div>

        <h3 className="mb-2 text-xl font-medium">Hosted sandboxed workers</h3>
        <p className="leading-relaxed text-gray-600">
          Every worker runs in an isolated environment so your team can automate safely without managing infrastructure.
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <div className="landing-shell flex flex-1 flex-col justify-center rounded-[2rem] p-6 md:p-8">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-100 bg-white shadow-sm">
            <MessageSquare size={20} className="text-gray-700" />
          </div>
          <h3 className="mb-2 flex flex-wrap items-center gap-2 text-xl font-medium">
            <span className="mr-1 inline-flex items-center gap-1.5 text-[1rem] text-gray-800">
              <AppleGlyph className="h-4 w-3.5 opacity-80" />
              <WindowsGlyph className="h-4 w-4 text-[#0078D4]" />
              <span className="text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-gray-500">
                Linux
              </span>
            </span>
            Desktop,
            <SlackGlyph className="h-4 w-4" />
            Slack, and
            <TelegramGlyph className="h-4 w-4" />
            Telegram access
          </h3>
          <p className="leading-relaxed text-gray-600">
            Run and monitor the same workers from the OpenWork desktop app or directly inside your team chats.
          </p>
        </div>

        <div className="landing-shell flex flex-1 flex-col justify-center rounded-[2rem] p-6 md:p-8">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-100 bg-white shadow-sm">
            <Blocks size={20} className="text-gray-700" />
          </div>
          <h3 className="mb-2 text-xl font-medium">Skills, agents, and MCP included</h3>
          <p className="leading-relaxed text-gray-600">
            Bring your existing OpenWork setup and everything is available immediately in each hosted worker.
          </p>
        </div>
      </div>
    </section>
  );
}
