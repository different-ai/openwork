"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import MacFrame from "@/components/ui/mac-frame";
import GithubIcon from "@/icons/brands/github-icon";
import SlackIcon from "@/icons/brands/slack-icon";
import NotionIcon from "@/icons/brands/notion-icon";
import GmailIcon from "@/icons/brands/gmail-icon";
import type { ComponentType } from "react";

interface ToolCall {
  label: string;
  result: string;
}

interface Session {
  id: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  prompt: string;
  tools: ToolCall[];
  reply: string;
  highlight: string;
  duration: string;
}

const SESSIONS: Session[] = [
  {
    id: "standup",
    label: "Standup digest",
    Icon: SlackIcon,
    prompt: "Pull yesterday's merged PRs and post a summary to #eng-standup.",
    tools: [
      { label: "github.list_pulls", result: "7 results" },
      { label: "slack.post", result: "#eng-standup" }
    ],
    reply: "Done. Posted a 7-PR summary, tagged 3 reviewers for follow-up.",
    highlight: "#eng-standup",
    duration: "2.4s"
  },
  {
    id: "release",
    label: "Release notes",
    Icon: GithubIcon,
    prompt: "Draft v1.2 release notes from the last 30 commits.",
    tools: [
      { label: "git.log", result: "30 commits" },
      { label: "github.create_release", result: "v1.2.0 draft" }
    ],
    reply: "Draft saved. 4 features, 6 fixes, 2 breaking. Ready for your review.",
    highlight: "v1.2.0",
    duration: "3.1s"
  },
  {
    id: "stripe",
    label: "Stripe → Notion",
    Icon: NotionIcon,
    prompt: "Reconcile last week's Stripe payouts into the Notion ledger.",
    tools: [
      { label: "stripe.list_payouts", result: "14 transactions" },
      { label: "notion.update_db", result: "ledger / 14 rows" }
    ],
    reply: "Reconciled $48,210 across 14 rows. 1 mismatch flagged for review.",
    highlight: "$48,210",
    duration: "5.7s"
  },
  {
    id: "inbox",
    label: "Inbox triage",
    Icon: GmailIcon,
    prompt: "Triage today's inbox — flag VIPs, archive newsletters.",
    tools: [
      { label: "gmail.list_messages", result: "112 unread" },
      { label: "gmail.archive", result: "47 newsletters" },
      { label: "gmail.label", result: "5 → @vip" }
    ],
    reply: "47 newsletters archived. 5 VIP messages flagged. 60 left in inbox.",
    highlight: "@vip",
    duration: "4.2s"
  }
];

type Phase = "idle" | "typing" | "thinking" | "tools" | "replying" | "done";

const TYPE_SPEED = 28; // ms per character
const TOOL_DELAY = 850; // ms between tool calls

export default function HeroAppPreview() {
  const [activeId, setActiveId] = useState<string>(SESSIONS[0].id);
  const [phase, setPhase] = useState<Phase>("idle");
  const [toolIdx, setToolIdx] = useState(0);
  const [typedPrompt, setTypedPrompt] = useState("");
  const [replyVisible, setReplyVisible] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const session = useMemo(() => SESSIONS.find((s) => s.id === activeId)!, [activeId]);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  const playSession = () => {
    clearTimers();
    setPhase("typing");
    setToolIdx(0);
    setTypedPrompt("");
    setReplyVisible(false);

    const text = session.prompt;
    text.split("").forEach((_char, i) => {
      timersRef.current.push(
        setTimeout(() => setTypedPrompt(text.slice(0, i + 1)), 200 + i * TYPE_SPEED)
      );
    });

    const promptDoneAt = 200 + text.length * TYPE_SPEED + 350;

    timersRef.current.push(setTimeout(() => setPhase("thinking"), promptDoneAt));
    timersRef.current.push(setTimeout(() => setPhase("tools"), promptDoneAt + 600));

    session.tools.forEach((_t, i) => {
      timersRef.current.push(
        setTimeout(() => setToolIdx(i + 1), promptDoneAt + 600 + (i + 1) * TOOL_DELAY)
      );
    });

    const replyAt = promptDoneAt + 600 + session.tools.length * TOOL_DELAY + 400;
    timersRef.current.push(setTimeout(() => setPhase("replying"), replyAt));
    timersRef.current.push(setTimeout(() => setReplyVisible(true), replyAt + 60));
    timersRef.current.push(setTimeout(() => setPhase("done"), replyAt + 600));
  };

  useEffect(() => {
    playSession();
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const isRunning = phase !== "done" && phase !== "idle";
  const visibleTools = session.tools.slice(0, toolIdx);

  return (
    <div className="relative">
      <div className="border-foreground/15 absolute -inset-base rounded-[1.6rem] border border-dashed pointer-events-none" aria-hidden />

      <MacFrame
        title={`OpenWork — ${session.label}`}
        className="relative shadow-[0_30px_80px_-30px_rgba(0,0,0,0.25)]"
      >
        <div className="grid grid-cols-[14rem_1fr] min-h-[44rem]">
          {/* Sidebar */}
          <aside className="border-foreground/10 bg-background-muted/60 border-r p-base flex flex-col">
            <p className="font-sans text-[1rem] font-bold uppercase tracking-[0.08em] text-foreground/40 mb-base px-xs">
              Workflows
            </p>
            <ul className="gap-2xs flex flex-col font-sans text-[1.2rem] font-medium">
              {SESSIONS.map((s) => {
                const isActive = s.id === activeId;
                const Icon = s.Icon;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      className={
                        "group relative w-full flex items-center gap-sm rounded-md px-sm py-xs text-left cursor-pointer transition-all duration-300 ease-out " +
                        (isActive
                          ? "bg-foreground text-background shadow-sm"
                          : "text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground hover:translate-x-[1px]")
                      }
                    >
                      <Icon className={"size-[1.4rem] shrink-0 transition-opacity " + (isActive ? "" : "opacity-60 group-hover:opacity-100")} />
                      <span className="truncate">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* Conversation */}
          <div className="flex flex-col min-h-0">
            {/* Header */}
            <div className="flex items-center justify-between border-foreground/10 border-b px-base-lg py-sm">
              <div className="flex items-center gap-xs">
                <span
                  className={
                    "size-[0.7rem] rounded-full transition-colors duration-500 " +
                    (isRunning ? "bg-amber-500" : phase === "done" ? "bg-emerald-500" : "bg-foreground/30")
                  }
                />
                <span className="font-sans text-[1.2rem] font-semibold">{session.label}</span>
                <span className="text-foreground/45 font-sans text-[1.1rem]">· Claude Opus 4.7</span>
              </div>
              <div className="flex items-center gap-sm">
                <span className="text-foreground/40 font-mono text-[1.1rem] tabular-nums w-[5rem] text-right">
                  {phase === "done" ? `✓ ${session.duration}` : phase === "thinking" ? "thinking…" : isRunning ? "running…" : ""}
                </span>
                <button
                  type="button"
                  onClick={playSession}
                  aria-label="Replay session"
                  className="border-foreground/15 hover:border-primary/60 hover:text-primary text-foreground/55 size-[2.4rem] inline-flex items-center justify-center rounded-full border border-dashed transition-colors cursor-pointer"
                >
                  <RotateCcw className="size-[1.2rem]" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex flex-col gap-sm p-base-lg overflow-hidden">
              {/* prompt */}
              <div
                className="bg-foreground text-background ml-auto max-w-[80%] rounded-2xl rounded-br-sm px-base py-sm font-sans text-[1.3rem] leading-relaxed transition-all duration-500 min-h-[3.4rem]"
                style={{
                  opacity: typedPrompt.length === 0 ? 0 : 1,
                  transform: typedPrompt.length === 0 ? "translateY(8px)" : "translateY(0)"
                }}
              >
                {typedPrompt}
                {phase === "typing" && (
                  <span className="ml-2xs inline-block w-[0.6rem] h-[1.4rem] bg-background/80 align-middle [animation:caret-blink_1s_steps(1)_infinite]" />
                )}
              </div>

              {/* tool calls */}
              <div className="flex flex-col gap-xs">
                {visibleTools.map((tool, i) => (
                  <div
                    key={tool.label}
                    className="border-foreground/10 bg-background-muted text-foreground/70 inline-flex w-fit items-center gap-xs rounded-md border px-sm py-2xs font-mono text-[1.1rem] tool-row"
                    style={{ animationDelay: `${i * 30}ms` }}
                  >
                    <Check className="size-[1.2rem] text-emerald-500 shrink-0" />
                    <span className="text-foreground">{tool.label}</span>
                    <span className="text-foreground/45">— {tool.result}</span>
                  </div>
                ))}
                {phase === "tools" && toolIdx < session.tools.length && (
                  <div className="text-foreground/40 inline-flex items-center gap-[0.3rem] font-mono text-[1.1rem] py-2xs px-sm">
                    <span className="bg-foreground/35 size-[0.5rem] rounded-full [animation:dot-bounce_1.2s_ease-in-out_infinite]" />
                    <span className="bg-foreground/35 size-[0.5rem] rounded-full [animation:dot-bounce_1.2s_ease-in-out_0.15s_infinite]" />
                    <span className="bg-foreground/35 size-[0.5rem] rounded-full [animation:dot-bounce_1.2s_ease-in-out_0.30s_infinite]" />
                  </div>
                )}
                {phase === "thinking" && (
                  <div className="text-foreground/40 inline-flex items-center gap-xs font-mono text-[1.1rem] py-2xs px-sm">
                    <span className="bg-foreground/35 size-[0.5rem] rounded-full [animation:dot-bounce_1.2s_ease-in-out_infinite]" />
                    <span className="bg-foreground/35 size-[0.5rem] rounded-full [animation:dot-bounce_1.2s_ease-in-out_0.15s_infinite]" />
                    <span className="bg-foreground/35 size-[0.5rem] rounded-full [animation:dot-bounce_1.2s_ease-in-out_0.30s_infinite]" />
                  </div>
                )}
              </div>

              {/* reply */}
              <div
                className="bg-background-muted border-foreground/10 max-w-[85%] rounded-2xl rounded-bl-sm border px-base py-sm font-sans text-[1.3rem] leading-relaxed transition-all duration-500"
                style={{
                  opacity: replyVisible ? 1 : 0,
                  transform: replyVisible ? "translateY(0)" : "translateY(12px)",
                  pointerEvents: replyVisible ? "auto" : "none"
                }}
              >
                {session.reply.split(session.highlight).map((part, i, arr) => (
                  <span key={i}>
                    {part}
                    {i < arr.length - 1 && (
                      <span className="text-primary font-semibold">{session.highlight}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>

            {/* Footer status bar */}
            <div className="mt-auto border-foreground/10 border-t px-base-lg py-sm flex items-center justify-between font-mono text-[1.05rem] text-foreground/40">
              <span className="inline-flex items-center gap-xs">
                <Check className="size-[1.1rem] text-emerald-500" />
                Permission: read-only · auto-approve
              </span>
              <span>{visibleTools.length}/{session.tools.length} tools</span>
            </div>
          </div>
        </div>
      </MacFrame>
    </div>
  );
}
