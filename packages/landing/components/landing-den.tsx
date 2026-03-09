"use client";

import { motion } from "framer-motion";
import { Blocks, Box, MessageSquare, Shield } from "lucide-react";
import { LandingBackground } from "./landing-background";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
  getStartedHref: string;
};

export function LandingDen(props: Props) {
  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={props.stars}
            downloadHref={props.downloadHref}
            active="den"
          />
        </div>

        <div className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <section className="max-w-3xl pt-10 md:pt-16">
            <div className="mb-4 flex items-center gap-2 font-medium text-gray-500">
              OpenWork hosted
            </div>
            <h1 className="mb-6 text-5xl font-medium leading-[1.1] tracking-tight md:text-6xl lg:text-7xl">
              Den
            </h1>
            <h2 className="mb-4 text-2xl font-medium tracking-tight text-gray-800 md:text-3xl">
              Hosted sandboxed workers for your team
            </h2>
            <p className="mb-8 text-lg leading-relaxed text-gray-700 md:text-xl">
              Den gives your team hosted sandboxed workers that you can access
              from our desktop app, Slack, or Telegram. All your skills, agents,
              and MCP integrations are directly available.
            </p>

            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <a
                href={props.getStartedHref}
                target="_blank"
                rel="noreferrer"
                className="doc-button"
              >
                Get started
              </a>
              <div className="text-sm text-gray-500">
                <span className="font-medium text-gray-700">
                  $50/month per worker.
                </span>{" "}
                Cancel anytime.
                <br />
                Early adopters get priority onboarding and custom workflow setup
                through March 1.
              </div>
            </div>
          </section>

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
                      times: [0, 0.2, 0.8, 1]
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
                      delay: 1
                    }}
                  />

                  <motion.div
                    className="group relative z-10 flex h-16 w-16 cursor-default items-center justify-center rounded-2xl border border-orange-200 bg-orange-100 shadow-inner"
                    animate={{ y: [-2, 2, -2] }}
                    transition={{
                      duration: 4,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                  >
                    <Box
                      size={28}
                      className="text-orange-500 transition-transform group-hover:scale-110"
                    />
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
                      delay: 0.5
                    }}
                  >
                    <Box
                      size={28}
                      className="text-blue-500 transition-transform group-hover:scale-110"
                    />
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

              <h3 className="mb-2 text-xl font-medium">
                Hosted sandboxed workers
              </h3>
              <p className="leading-relaxed text-gray-600">
                Every worker runs in an isolated environment so your team can
                automate safely without managing infrastructure.
              </p>
            </div>

            <div className="flex flex-col gap-6">
              <div className="landing-shell flex flex-1 flex-col justify-center rounded-[2rem] p-6 md:p-8">
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-100 bg-white shadow-sm">
                  <MessageSquare size={20} className="text-gray-700" />
                </div>
                <h3 className="mb-2 flex flex-wrap items-center gap-2 text-xl font-medium">
                  <span className="mr-1 flex items-center gap-1.5">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 384 512"
                      className="h-4 w-3.5 fill-black opacity-80"
                      aria-label="macOS"
                    >
                      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.3 48.6-.7 90.4-84.3 103.1-118.8-45.9-19.8-62.2-56.7-62.2-91.8zM245.8 111.4C268.4 84.8 281.3 47.9 277 11.2c-31.1 1.2-70.3 20.8-93.5 47.4-19.1 21.6-34.6 59.5-29.4 95.3 34.6 2.7 70.8-16.7 91.7-42.5z" />
                    </svg>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      className="h-4 w-4 fill-[#0078D4]"
                      aria-label="Windows"
                    >
                      <path d="M0 0h11.377v11.377H0zm12.623 0H24v11.377H12.623zM0 12.623h11.377V24H0zm12.623 0H24V24H12.623z" />
                    </svg>
                    <img
                      src="https://upload.wikimedia.org/wikipedia/commons/3/35/Tux.svg"
                      alt="Linux"
                      className="h-4 w-4 object-contain"
                    />
                  </span>
                  Desktop,
                  <img
                    src="https://upload.wikimedia.org/wikipedia/commons/d/d5/Slack_icon_2019.svg"
                    alt="Slack"
                    className="h-5 w-5"
                  />
                  Slack, and
                  <img
                    src="https://upload.wikimedia.org/wikipedia/commons/8/82/Telegram_logo.svg"
                    alt="Telegram"
                    className="h-5 w-5"
                  />
                  Telegram access
                </h3>
                <p className="leading-relaxed text-gray-600">
                  Run and monitor the same workers from the OpenWork desktop app
                  or directly inside your team chats.
                </p>
              </div>

              <div className="landing-shell flex flex-1 flex-col justify-center rounded-[2rem] p-6 md:p-8">
                <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-100 bg-white shadow-sm">
                  <Blocks size={20} className="text-gray-700" />
                </div>
                <h3 className="mb-2 text-xl font-medium">
                  Skills, agents, and MCP included
                </h3>
                <p className="leading-relaxed text-gray-600">
                  Bring your existing OpenWork setup and everything is available
                  immediately in each hosted worker.
                </p>
              </div>
            </div>
          </section>

          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
