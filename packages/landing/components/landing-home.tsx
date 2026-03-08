"use client";

import Link from "next/link";
import { AnimatePresence, motion, useInView } from "framer-motion";
import { Check, ChevronRight, Shield } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { LandingBackground } from "./landing-background";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import { ResponsiveGrain } from "./responsive-grain";
import { WaitlistForm } from "./waitlist-form";

type ChatMessage =
  | {
      role: "user" | "agent";
      content: string;
    }
  | {
      role: "timeline";
      items: string[];
    };

type DemoFlow = {
  id: string;
  categoryLabel: string;
  tabLabel: string;
  title: string;
  description: string;
  activeAgent: { name: string; color: string };
  agents: { name: string; desc: string; color: string }[];
  task: string;
  context: string;
  output: string;
  chatHistory: ChatMessage[];
};

const demoFlows: DemoFlow[] = [
  {
    id: "browser-automation",
    categoryLabel: "Browser Automation",
    tabLabel: "Like Twitter replies and export users",
    title: "Like Twitter replies and export users",
    description:
      "Turn plain-language requests into browser actions across the tools your team already uses.",
    activeAgent: {
      name: "Browser Operator",
      color: "bg-[#2463eb]"
    },
    agents: [
      {
        name: "Digital Twin",
        desc: "Extended digital you",
        color: "bg-[#4f6ee8]"
      },
      {
        name: "Sales Inbound",
        desc: "Qualifies leads",
        color: "bg-[#f97316]"
      },
      {
        name: "Personal",
        desc: "Daily tasks",
        color: "bg-[#0f9f7f]"
      }
    ],
    task:
      'Open this Twitter thread, like all the replies, and extract the user details into a CSV file.',
    context:
      'Ensure you scroll through the entire thread to load all replies before interacting and extracting data.',
    output: 'Save the extracted data as "tweet_replies.csv" on my desktop.',
    chatHistory: [
      {
        role: "user",
        content:
          "Here is a link to a tweet: https://x.com/user/status/12345. Like all the replies and save the user details to a CSV on your computer."
      },
      {
        role: "timeline",
        items: [
          "Execution timeline 1 step - Navigates to tweet URL in browser",
          'Execution timeline 4 steps - Scrolls to load and clicks "like" on all 42 replies',
          "Execution timeline 2 steps - Extracts usernames and bio data",
          'Execution timeline 1 step - Writes tweet_replies.csv to local filesystem'
        ]
      },
      {
        role: "agent",
        content:
          'I have successfully liked 42 replies on that thread and saved the user details to "tweet_replies.csv" on your computer. Is there anything else you need?'
      }
    ]
  },
  {
    id: "data-analysis",
    categoryLabel: "Data Analysis",
    tabLabel: "Summarize Q3 revenue outliers",
    title: "Summarize Q3 revenue outliers",
    description:
      "Work from Excel files or pasted spreadsheets without changing how your team already shares data.",
    activeAgent: {
      name: "Excel Analyst",
      color: "bg-[#0f9f7f]"
    },
    agents: [
      {
        name: "Digital Twin",
        desc: "Extended digital you",
        color: "bg-[#4f6ee8]"
      },
      {
        name: "Sales Inbound",
        desc: "Qualifies leads",
        color: "bg-[#f97316]"
      },
      {
        name: "Personal",
        desc: "Daily tasks",
        color: "bg-[#0f9f7f]"
      }
    ],
    task:
      "Analyze this Excel model even if the user uploads the file or pastes the spreadsheet directly into chat.",
    context:
      "Flag the biggest changes in revenue, explain the outliers, and compare each segment against plan.",
    output:
      "Return the findings as a clean table plus a short executive summary.",
    chatHistory: [
      {
        role: "user",
        content: "Here is the Q3_Financials.xlsx file. Find the biggest outliers."
      },
      {
        role: "timeline",
        items: [
          "Execution timeline 1 step - Reads Q3_Financials.xlsx",
          "Execution timeline 2 steps - Parses sheets and normalizes data",
          "Execution timeline 1 step - Runs statistical anomaly detection"
        ]
      },
      {
        role: "agent",
        content:
          "I analyzed the spreadsheet and found 3 major outliers. The most significant is a 42% spike in marketing spend during August, which correlates with the new campaign launch."
      }
    ]
  },
  {
    id: "outreach-creation",
    categoryLabel: "Outreach Creation",
    tabLabel: "Draft follow-up for Acme Corp",
    title: "Draft follow-up for Acme Corp",
    description:
      "Turn Notion MCP context into personalized outreach, then push the final result into your CRM.",
    activeAgent: {
      name: "Outreach Writer",
      color: "bg-[#d97706]"
    },
    agents: [
      {
        name: "Digital Twin",
        desc: "Extended digital you",
        color: "bg-[#4f6ee8]"
      },
      {
        name: "Sales Inbound",
        desc: "Qualifies leads",
        color: "bg-[#f97316]"
      },
      {
        name: "Personal",
        desc: "Daily tasks",
        color: "bg-[#0f9f7f]"
      }
    ],
    task:
      "Draft founder outreach from our Notion workspace, then save the final message and next step into HubSpot.",
    context:
      "Use the Notion MCP notes for tone, product context, and the last touchpoint before writing.",
    output: "Create the email, update the CRM record, and queue the follow-up.",
    chatHistory: [
      {
        role: "user",
        content:
          "Draft a follow-up to Acme Corp based on our last meeting notes in Notion."
      },
      {
        role: "timeline",
        items: [
          'Execution timeline 1 step - Queries Notion MCP for "Acme Corp meeting notes"',
          "Execution timeline 2 steps - Extracts action items and tone preferences",
          "Execution timeline 1 step - Generates personalized email draft"
        ]
      },
      {
        role: "agent",
        content:
          "I've drafted the follow-up email based on the action items from the Notion notes. It highlights the custom integration timeline we discussed. Would you like me to push this to HubSpot?"
      }
    ]
  }
];

type Props = {
  stars: string;
  downloadHref: string;
  callHref: string;
  isMobileVisitor: boolean;
};

const externalLinkProps = (href: string) =>
  /^https?:\/\//.test(href)
    ? { rel: "noreferrer", target: "_blank" as const }
    : {};

export function LandingHome(props: Props) {
  const [activeDemoId, setActiveDemoId] = useState(demoFlows[0].id);
  const [activeUseCase, setActiveUseCase] = useState(0);
  const enterpriseShowcaseRef = useRef<HTMLElement>(null);
  const showEnterpriseShowcase = useInView(enterpriseShowcaseRef, {
    once: true,
    margin: "-15% 0px"
  });

  const activeDemo = useMemo(
    () => demoFlows.find((flow) => flow.id === activeDemoId) ?? demoFlows[0],
    [activeDemoId]
  );

  const downloadLinkProps = externalLinkProps(props.downloadHref);
  const callLinkProps = externalLinkProps(props.callHref);
  const primaryCtaHref = props.isMobileVisitor ? "#mobile-signup" : props.downloadHref;
  const primaryCtaLabel = props.isMobileVisitor
    ? "Sign up for desktop access"
    : "Download for free";
  const primaryCtaLinkProps = props.isMobileVisitor ? {} : downloadLinkProps;

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={props.stars}
            downloadHref={props.downloadHref}
            callUrl={props.callHref}
            mobilePrimaryHref="#mobile-signup"
            mobilePrimaryLabel="Sign up"
            active="home"
          />
        </div>

        <div className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <section className="max-w-3xl">
            <h1 className="mb-5 text-4xl font-medium leading-[1.1] tracking-tight md:text-5xl lg:text-6xl">
              The open source{" "}
              <span className="font-pixel mx-1 inline-block align-middle text-[1.05em] font-normal">
                alt
              </span>{" "}
              to
              <br />
              Claude Cowork
            </h1>
            <p className="mb-6 max-w-4xl text-lg leading-relaxed text-gray-700 md:mb-7 md:text-xl">
              OpenWork is the desktop app that lets you use 50+ LLMs, bring your
              own keys, and share your setups seamlessly with your team.
            </p>

            <div className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                <a
                  href={primaryCtaHref}
                  className="doc-button"
                  {...primaryCtaLinkProps}
                >
                  {primaryCtaLabel}
                </a>
                <a
                  href={props.callHref}
                  className="secondary-button"
                  {...callLinkProps}
                >
                  Contact sales
                </a>
              </div>

              <div className="flex items-center gap-2 opacity-80 sm:ml-4">
                <span className="text-[13px] font-medium text-gray-500">
                  Backed by
                </span>
                <div className="flex items-center gap-1.5">
                  <div className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[#ff6600] text-[11px] font-bold leading-none text-white">
                    Y
                  </div>
                  <span className="text-[13px] font-semibold tracking-tight text-gray-600">
                    Combinator
                  </span>
                </div>
              </div>
            </div>
          </section>

          {props.isMobileVisitor ? (
            <section
              id="mobile-signup"
              className="landing-shell-soft -mt-6 rounded-[2rem] p-6 md:hidden"
            >
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-400">
                Mobile signup
              </div>
              <h2 className="mb-3 text-2xl font-medium leading-tight text-[#011627]">
                Start on mobile. Continue on desktop.
              </h2>
              <p className="mb-5 text-[15px] leading-7 text-gray-600">
                OpenWork is a desktop app. Sign up here from your phone and keep the
                desktop install flow handy for when you switch to your computer.
              </p>
              <WaitlistForm />
              <p className="mt-4 text-[13px] leading-6 text-gray-500">
                Best path on mobile: landing, signup, then download on desktop.
              </p>
            </section>
          ) : null}

          <section className="relative flex flex-col gap-6 overflow-hidden md:gap-8">
            <div className="landing-shell relative flex flex-col overflow-hidden rounded-2xl">
              <div className="relative z-20 flex h-10 w-full shrink-0 items-center border-b border-white/50 bg-gradient-to-b from-white/90 to-white/60 px-4">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full border border-[#e0443e]/20 bg-[#ff5f56]/90 shadow-sm"></div>
                  <div className="h-3 w-3 rounded-full border border-[#dea123]/20 bg-[#ffbd2e]/90 shadow-sm"></div>
                  <div className="h-3 w-3 rounded-full border border-[#1aab29]/20 bg-[#27c93f]/90 shadow-sm"></div>
                </div>
                <div className="absolute left-1/2 -translate-x-1/2 text-[12px] font-medium tracking-wide text-gray-500">
                  OpenWork
                </div>
              </div>
 
              <div className="bg-white p-4 md:p-6">
                <div className="relative z-10 flex flex-col gap-4 md:flex-row">
                  <div className="flex w-full flex-col gap-1 rounded-2xl border border-gray-100 bg-gray-50 p-2 md:w-1/3">
                    <div className="flex items-center justify-between rounded-xl bg-gray-100/90 p-3">
                      <div className="flex items-center gap-3">
                        <div
                            className={`h-6 w-6 rounded-full ${activeDemo.activeAgent.color}`}
                        ></div>
                        <span className="text-sm font-medium">
                          {activeDemo.activeAgent.name}
                        </span>
                      </div>
                      <span className="text-xs text-gray-400">Active</span>
                    </div>

                    {activeDemo.agents.map((agent) => (
                      <div
                        key={agent.name}
                        className="flex cursor-pointer items-center justify-between rounded-xl p-3 transition-colors hover:bg-gray-50/80"
                      >
                        <div className="flex items-center gap-3">
                          <div
                              className={`h-6 w-6 rounded-full ${agent.color}`}
                          ></div>
                          <span className="text-sm font-medium">{agent.name}</span>
                        </div>
                        <span className="text-xs text-gray-400">{agent.desc}</span>
                      </div>
                    ))}

                    <div className="mt-4 px-1 pb-1">
                      <div className="relative flex flex-col gap-1 pl-3 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-[2px] before:bg-gray-100 before:content-['']">
                        {demoFlows.map((flow, idx) => {
                          const isActive = flow.id === activeDemo.id;
                          const timeAgo =
                            idx === 0 ? "1s ago" : idx === 1 ? "15m ago" : "22h ago";

                          return (
                            <button
                              key={flow.id}
                              type="button"
                              onClick={() => setActiveDemoId(flow.id)}
                              className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors ${
                                isActive ? "bg-gray-100/80" : "hover:bg-gray-50/80"
                              }`}
                            >
                              <span
                                className={`mr-2 truncate ${
                                  isActive
                                    ? "font-medium text-gray-700"
                                    : "text-gray-600"
                                }`}
                              >
                                {flow.tabLabel}
                              </span>
                              <span className="whitespace-nowrap text-gray-400">
                                {timeAgo}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="flex min-h-[400px] w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm md:w-2/3">
                    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6 text-[13px]">
                      {activeDemo.chatHistory.map((message, idx) => {
                        if (message.role === "user") {
                          return (
                            <div
                              key={idx}
                              className="mt-2 max-w-[85%] self-center rounded-3xl bg-gray-100/80 px-5 py-3 text-center text-gray-800"
                            >
                              {message.content}
                            </div>
                          );
                        }

                        if (message.role === "timeline") {
                          return (
                            <div
                              key={idx}
                              className="ml-2 flex flex-col gap-3 text-xs text-gray-400"
                            >
                              {message.items.map((item) => (
                                <div key={item} className="flex items-center gap-2">
                                  <ChevronRight size={10} className="text-gray-300" />
                                  <span>{item}</span>
                                </div>
                              ))}
                            </div>
                          );
                        }

                        return (
                          <div
                            key={idx}
                            className="mb-2 ml-2 max-w-[95%] text-[13px] leading-relaxed text-gray-800"
                          >
                            {message.content}
                          </div>
                        );
                      })}
                    </div>

                    <div className="border-t border-white/50 bg-white/50 p-4">
                      <div className="mb-2 px-1 text-xs text-gray-400">
                        Describe your task
                      </div>
                      <div className="rounded-xl border border-gray-100 bg-white p-3.5 text-sm leading-relaxed text-[#011627] shadow-sm">
                        {activeDemo.task}{" "}
                        <span className="text-gray-400">[task]</span>{" "}
                        {activeDemo.context}{" "}
                        <span className="text-gray-400">[context]</span>{" "}
                        {activeDemo.output}{" "}
                        <span className="text-gray-400">[result]</span>
                      </div>
                      <div className="mt-3 flex items-center justify-end px-1">
                        <button
                          type="button"
                          className="rounded-full bg-[#011627] px-6 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-black"
                        >
                          Run Task
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="relative z-10 mb-4 flex w-full flex-col items-start justify-between gap-4 px-2 md:flex-row md:items-center">
              <div className="landing-chip flex w-full flex-wrap gap-2 overflow-x-auto rounded-full p-1.5 md:w-[600px]">
                {demoFlows.map((flow) => {
                  const isActive = flow.id === activeDemo.id;

                  return (
                    <button
                      key={flow.id}
                      type="button"
                      onClick={() => setActiveDemoId(flow.id)}
                      aria-pressed={isActive}
                      className={`relative cursor-pointer whitespace-nowrap rounded-full px-5 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? "text-[#011627]"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      {isActive ? (
                        <motion.div
                          layoutId="active-pill"
                          className="absolute inset-0 rounded-full border border-gray-100 bg-white shadow-sm"
                          transition={{ type: "spring", stiffness: 400, damping: 30 }}
                        />
                      ) : null}
                      <span className="relative z-10">{flow.categoryLabel}</span>
                    </button>
                  );
                })}
              </div>

              <div className="min-h-[44px] text-left md:text-right">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeDemo.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="text-lg font-medium text-[#011627]">
                      {activeDemo.title}
                    </div>
                    <div className="ml-auto mt-1 max-w-md text-sm text-gray-500">
                      {activeDemo.description}
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </section>

          <section className="mt-4 md:mt-6">
            <div className="mb-10 grid gap-10 md:mb-12 md:grid-cols-2 md:gap-12">
              <div>
                <h2 className="mb-3 text-2xl font-medium">OpenWork Desktop</h2>
                <p className="mb-6 text-lg leading-relaxed text-gray-600">
                  {props.isMobileVisitor
                    ? "Sign up from your phone now, then download OpenWork on desktop when you are back at your computer."
                    : "Start free on desktop with no signup, then automate email, Slack, and the work you do every day."}
                </p>
                <a href={primaryCtaHref} className="doc-button" {...primaryCtaLinkProps}>
                  {primaryCtaLabel}
                </a>
              </div>

              <div>
                <h2 className="mb-3 text-2xl font-medium">OpenWork Den</h2>
                <p className="mb-6 text-lg leading-relaxed text-gray-600">
                  Run those same workers in the cloud when you need them always
                  on, without hosting them yourself.
                </p>
                <Link
                  href="/den"
                  className="secondary-button text-sm"
                >
                  Learn More
                </Link>
              </div>
            </div>
          </section>

          <section className="mt-4 max-w-3xl md:mt-6">
            <div className="mb-4 font-medium text-gray-500">OpenWork Den</div>
            <h2 className="mb-6 text-4xl font-medium leading-[1.1] tracking-tight md:text-5xl lg:text-6xl">
              Hosted sandboxed workers
              <br />
              for your team
            </h2>
            <p className="mb-8 text-lg leading-relaxed text-gray-700 md:text-xl">
              Den gives your team hosted sandboxed workers that you can access
              from our desktop app, Slack, or Telegram. All your skills,
              agents, and MCP integrations are directly available.
            </p>
            <Link href="/den" className="doc-button">
              Get started
            </Link>
          </section>

          <section
            ref={enterpriseShowcaseRef}
            className="landing-shell mt-4 rounded-[2.5rem] p-8 md:mt-6 md:p-12"
          >
            <div className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-400">
              For Enterprises, Startups &amp; Teams
            </div>
            <h2 className="mb-16 max-w-2xl text-3xl font-medium leading-[1.15] tracking-tight md:text-4xl lg:text-5xl">
              Package once, run everywhere. Safe workflow sharing.
            </h2>

            <div className="flex flex-col gap-12 lg:flex-row lg:gap-20">
              <div className="flex w-full flex-col gap-10 lg:w-1/3">
                <button
                  type="button"
                  className={`${
                    activeUseCase === 0 ? "opacity-100" : "opacity-50 hover:opacity-100"
                  } text-left transition-opacity`}
                  onClick={() => setActiveUseCase(0)}
                >
                  <h3
                    className={`mb-2 text-xl font-medium ${
                      activeUseCase === 0 ? "text-[#011627]" : "text-gray-800"
                    }`}
                  >
                    Build Once, Share Widely
                  </h3>
                  <p
                    className={`text-sm leading-relaxed ${
                      activeUseCase === 0 ? "text-[#011627]" : "text-gray-600"
                    }`}
                  >
                    Create a skill or automation on your local desktop, then
                    instantly generate a secure sharing link for your entire
                    team. No complex setups required.
                  </p>
                </button>

                <button
                  type="button"
                  className={`${
                    activeUseCase === 1 ? "opacity-100" : "opacity-50 hover:opacity-100"
                  } text-left transition-opacity`}
                  onClick={() => setActiveUseCase(1)}
                >
                  <h3
                    className={`mb-2 text-xl font-medium ${
                      activeUseCase === 1 ? "text-[#011627]" : "text-gray-800"
                    }`}
                  >
                    Cloud Hosted Sandboxes
                  </h3>
                  <p
                    className={`text-sm leading-relaxed ${
                      activeUseCase === 1 ? "text-[#011627]" : "text-gray-600"
                    }`}
                  >
                    Give your team access to hosted, sandboxed workers via
                    OpenWork Den. Run the exact same workflows safely in the
                    cloud without managing infrastructure.
                  </p>
                </button>

                <button
                  type="button"
                  className={`${
                    activeUseCase === 2 ? "opacity-100" : "opacity-50 hover:opacity-100"
                  } text-left transition-opacity`}
                  onClick={() => setActiveUseCase(2)}
                >
                  <h3
                    className={`mb-2 text-xl font-medium ${
                      activeUseCase === 2 ? "text-[#011627]" : "text-gray-800"
                    }`}
                  >
                    Anywhere Access
                  </h3>
                  <p
                    className={`text-sm leading-relaxed ${
                      activeUseCase === 2 ? "text-[#011627]" : "text-gray-600"
                    }`}
                  >
                    Run and monitor your shared workers from the OpenWork
                    desktop app, or interact with them directly inside your
                    team&apos;s Slack or Telegram channels.
                  </p>
                </button>
              </div>

              <div className="landing-canvas relative flex min-h-[400px] w-full items-center justify-center overflow-hidden rounded-3xl p-6 lg:w-2/3 md:p-10">
                {showEnterpriseShowcase ? (
                  <>
                    <ResponsiveGrain
                colors={["#f97316", "#a855f7", "#3b82f6", "#fcd34d"]}
                colorBack="#f97316"
                softness={0.6}
                intensity={0.8}
                noise={0.3}
                shape="corners"
                speed={0.5}
              />
                    <div className="absolute left-8 top-8 h-28 w-28 rounded-[2rem] border border-white/60 bg-white/30" />
                    <div className="absolute bottom-8 right-8 h-40 w-40 rounded-full border border-white/60 bg-white/24" />
                  </>
                ) : null}

                {showEnterpriseShowcase ? (
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={activeUseCase}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className="z-10 flex w-full justify-center"
                    >
                      {activeUseCase === 0 ? (
                        <div className="landing-shell-soft flex w-full max-w-md flex-col gap-6 rounded-[2rem] p-6 text-center md:p-8">
                          <div>
                            <h3 className="text-xl font-semibold tracking-tight text-[#011627]">
                              Package Your Worker
                            </h3>
                            <p className="mt-1 text-sm text-gray-500">
                              Drag and drop skills, agents, or MCPs here to bundle
                              them.
                            </p>
                          </div>

                          <div className="group flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50/50 p-8 transition-colors hover:bg-gray-50">
                            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 transition-transform group-hover:scale-105">
                              <svg
                                width="24"
                                height="24"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#1a44f2"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                <polyline points="17 8 12 3 7 8"></polyline>
                                <line x1="12" y1="3" x2="12" y2="15"></line>
                              </svg>
                            </div>
                            <div className="text-[15px] font-medium text-[#011627]">
                              Drop OpenWork files here
                            </div>
                            <div className="mt-1 text-[13px] text-gray-400">
                              or click to browse local files
                            </div>
                          </div>

                          <div className="flex flex-col gap-2 text-left">
                            <div className="mb-1 px-1 text-xs font-bold uppercase tracking-wider text-gray-400">
                              Included
                            </div>
                            <div className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#f97316] text-white">
                                <Shield size={16} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-[#011627]">
                                  Sales Inbound
                                </div>
                                <div className="text-[12px] text-gray-500">
                                  Agent · v1.2.0
                                </div>
                              </div>
                              <Check size={16} className="shrink-0 text-green-500" />
                            </div>
                          </div>

                          <button
                            type="button"
                            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[#011627] py-3.5 text-[15px] font-medium text-white shadow-md transition-colors hover:bg-black"
                          >
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                            </svg>
                            Generate Share Link
                          </button>
                        </div>
                      ) : null}

                      {activeUseCase === 1 ? (
                        <div className="landing-shell flex w-full max-w-lg flex-col gap-6 rounded-[2rem] p-4 md:p-8">
                          <div className="landing-chip mb-2 flex w-fit items-center justify-between rounded-full p-1">
                            <button
                              type="button"
                              className="flex items-center gap-2 rounded-full border border-gray-100 bg-white px-4 py-2 text-sm font-medium shadow-sm"
                            >
                              <div className="h-3 w-3 rounded-full bg-[#f97316]"></div>
                              Cloud Workers
                            </button>
                          </div>

                          <div className="landing-shell-soft flex w-full flex-col gap-3 rounded-2xl p-2">
                            <div className="group relative cursor-pointer rounded-xl bg-gray-50/80 p-4">
                              <div className="mb-1 flex items-center justify-between">
                                <div className="text-[15px] font-medium text-[#011627] transition-colors group-hover:text-blue-600">
                                  Founder Ops Pilot
                                </div>
                                <div className="flex items-center gap-1.5 rounded border border-green-100/50 bg-green-50 px-2 py-1">
                                  <div className="h-1.5 w-1.5 rounded-full bg-green-500"></div>
                                  <span className="text-[10px] font-bold tracking-wider text-green-700">
                                    READY
                                  </span>
                                </div>
                              </div>
                              <div className="mb-4 text-[13px] text-gray-500">
                                Assists with operations and onboarding.
                              </div>

                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  className="rounded-full bg-[#011627] px-4 py-2 text-center text-xs font-medium text-white shadow-sm transition-colors hover:bg-black"
                                >
                                  Open in OpenWork
                                </button>
                                <button
                                  type="button"
                                  className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-center text-xs font-medium text-[#011627] shadow-sm transition-colors hover:bg-gray-50"
                                >
                                  <svg
                                    viewBox="0 0 24 24"
                                    width="14"
                                    height="14"
                                    fill="currentColor"
                                  >
                                    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.523-2.523 2.526 2.526 0 0 1 2.52-2.52V21.48A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
                                  </svg>
                                  Connect to Slack
                                </button>
                              </div>
                            </div>

                            <div className="group relative cursor-pointer rounded-xl border border-transparent p-4 transition-colors hover:border-gray-100 hover:bg-gray-50/80">
                              <div className="mb-1 flex items-center justify-between">
                                <div className="text-[15px] font-medium text-[#011627] transition-colors group-hover:text-blue-600">
                                  Marketing Copilot
                                </div>
                                <div className="flex items-center gap-1.5 rounded border border-gray-200 bg-gray-50 px-2 py-1">
                                  <div className="h-1.5 w-1.5 rounded-full bg-gray-400"></div>
                                  <span className="text-[10px] font-bold tracking-wider text-gray-500">
                                    OFFLINE
                                  </span>
                                </div>
                              </div>
                              <div className="text-[13px] text-gray-500">
                                Creates draft campaigns from Notion docs.
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}

                    {activeUseCase === 2 ? (
                      <div className="landing-shell-soft flex h-[380px] w-full max-w-lg flex-col overflow-hidden rounded-2xl p-0">
                        <div className="flex items-center gap-3 bg-[#4A154B] px-4 py-3">
                          <div className="hidden h-3 w-3 rounded-full bg-red-500/80 sm:block"></div>
                          <div className="hidden h-3 w-3 rounded-full bg-yellow-500/80 sm:block"></div>
                          <div className="hidden h-3 w-3 rounded-full bg-green-500/80 sm:block"></div>
                          <div className="flex-1 text-center text-sm font-medium text-white/90">
                            # general
                          </div>
                        </div>

                        <div className="flex flex-1 flex-col gap-5 overflow-y-auto bg-white p-4">
                          <div className="flex gap-3">
                            <div className="h-8 w-8 flex-shrink-0 rounded bg-[#2463eb]"></div>
                            <div className="flex flex-col">
                              <div className="flex items-baseline gap-2">
                                <span className="text-[15px] font-bold text-[#1d1c1d]">
                                  You
                                </span>
                                <span className="text-xs text-gray-500">11:42 AM</span>
                              </div>
                              <div className="mt-1 text-[15px] leading-relaxed text-[#1d1c1d]">
                                <span className="rounded bg-[#e8f5fa] px-1 text-[#1164A3]">
                                  @SalesBot
                                </span>{" "}
                                get my notion info and share it to{" "}
                                <span className="rounded bg-[#e8f5fa] px-1 text-[#1164A3]">
                                  @john
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="flex gap-3">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded bg-[#1a44f2] text-xs font-bold text-white">
                              SB
                            </div>
                            <div className="flex w-full flex-col">
                              <div className="flex items-baseline gap-2">
                                <span className="text-[15px] font-bold text-[#1d1c1d]">
                                  SalesBot
                                </span>
                                <span className="rounded bg-gray-100 px-1 py-0.5 text-[10px] font-bold uppercase text-gray-500">
                                  APP
                                </span>
                                <span className="text-xs text-gray-500">11:43 AM</span>
                              </div>
                              <div className="mt-1 text-[15px] leading-relaxed text-[#1d1c1d]">
                                I&apos;ve found your latest Notion notes regarding
                                the Acme Corp deal. I just sent a direct message
                                to{" "}
                                <span className="rounded bg-[#e8f5fa] px-1 text-[#1164A3]">
                                  @john
                                </span>{" "}
                                with a summarized bulleted list.
                              </div>
                              <div className="mt-3 border-l-4 border-[#1a44f2] py-1 pl-3">
                                <div className="text-[14px] font-medium">
                                  Action Complete
                                </div>
                                <div className="mt-1 text-[14px] text-gray-600">
                                  Queried Notion MCP and successfully executed 1
                                  automation workflow.
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="border-t border-gray-200 bg-white p-4">
                          <div className="rounded-lg border border-gray-400 p-3 text-sm text-gray-400">
                            Message #general
                          </div>
                        </div>
                      </div>
                    ) : null}
                    </motion.div>
                  </AnimatePresence>
                ) : (
                  <div className="z-10 flex w-full justify-center">
                    <div className="landing-shell-soft h-[380px] w-full max-w-lg rounded-[2rem] border border-dashed border-slate-300/80 bg-white/70" />
                  </div>
                )}
              </div>
            </div>
          </section>

          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
