"use client";

import { ArrowUp, ChevronRight, FileSpreadsheet, FileText, Plus, Presentation, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { DownloadLink } from "./download-link";
import { DemoMenu, focusRing } from "./lp-demo-ui";
import { GoogleDriveMark, LinearMark, SkillMark, SlackMark } from "./lp-service-marks";

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

export type SessionId = string;

type Step = { mark: ReactNode; text: string; duration?: string };
type Artifact = { name: string; meta: string; icon: "doc" | "sheet" | "slides"; lines: string[] };
type Approval = { title: string; detail: string; action: string; done: string };

export type DemoSession = {
  id: SessionId;
  title: string;
  group: "pinned" | "marketing" | "personal";
  meta: string;
  unread?: boolean;
  prompt: string;
  steps: Step[];
  worked?: string;
  reply: string;
  artifact?: Artifact;
  approval?: Approval;
  /** Sessions started in the preview get the preview reply instead of a scripted run. */
  custom?: boolean;
};

const fileIcon = <FileText size={16} strokeWidth={1.5} className="text-[#4B5563]" />;

export const INITIAL_SESSIONS: DemoSession[] = [
  {
    id: "q3",
    title: "Q3 board prep",
    group: "pinned",
    meta: "2d",
    prompt: "Build a one-page Q3 summary for the board from the revenue sheet in Drive.",
    steps: [
      { mark: <GoogleDriveMark className="h-4 w-4" />, text: "Read Q3 revenue.xlsx · Google Drive", duration: "0.9s" },
      { mark: fileIcon, text: "Created q3-board-summary.pptx", duration: "2.1s" }
    ],
    worked: "Worked for 3s",
    reply: "Done. One slide with revenue, growth by plan, and the three questions the board asked last quarter.",
    artifact: {
      name: "q3-board-summary.pptx",
      meta: "Presentation · 6 slides",
      icon: "slides",
      lines: ["Q3 at a glance", "Revenue $1.84M, up 18% on Q2", "Team plans: 41% of new revenue", "Churn down to 2.1%", "Open questions: hiring plan, EU launch, pricing"]
    }
  },
  {
    id: "weekly",
    title: "Weekly update",
    group: "marketing",
    meta: "now",
    prompt: "Pull last week's closed Linear issues and the Q3 numbers from Drive, then draft the weekly update for #launch.",
    steps: [
      { mark: <LinearMark className="h-4 w-4" />, text: "Searched issues · Linear — “closed last week” · 23 issues", duration: "1.2s" },
      { mark: <GoogleDriveMark className="h-4 w-4" />, text: "Read Q3 revenue.xlsx · Google Drive", duration: "0.8s" },
      { mark: <SkillMark className="h-4 w-4" />, text: "Used your Weekly update skill" },
      { mark: fileIcon, text: "Wrote weekly-update.md", duration: "0.3s" }
    ],
    worked: "Worked for 2s",
    reply: "Here's the draft. 23 issues closed, led by the new billing page. Q3 revenue is up 18% on Q2, mostly from the two new team plans.",
    artifact: {
      name: "weekly-update.md",
      meta: "Draft · 214 words",
      icon: "doc",
      lines: ["Weekly update — Sep 22–26", "Shipped: new billing page, faster exports, 21 fixes", "Numbers: Q3 revenue up 18% on Q2", "Next week: EU pricing and the onboarding checklist"]
    },
    approval: {
      title: "Post weekly-update.md to #launch?",
      detail: "48 people will see it. You can delete it from Slack.",
      action: "Post to #launch",
      done: "Posted to #launch"
    }
  },
  {
    id: "invoices",
    title: "Clean up invoices.xlsx",
    group: "marketing",
    meta: "",
    unread: true,
    prompt: "Clean up invoices.xlsx: fix the dates, remove duplicates, and total it by client.",
    steps: [
      { mark: <FileSpreadsheet size={16} strokeWidth={1.5} className="text-[#047857]" />, text: "Read invoices.xlsx · 212 rows", duration: "0.4s" },
      { mark: <FileSpreadsheet size={16} strokeWidth={1.5} className="text-[#047857]" />, text: "Edited invoices.xlsx", duration: "1.6s" }
    ],
    worked: "Worked for 2s",
    reply: "Removed 9 duplicates, fixed 31 dates to YYYY-MM-DD, and added a Totals by client sheet. Acme is your largest client at $48,200.",
    artifact: {
      name: "invoices.xlsx",
      meta: "Spreadsheet · 203 rows",
      icon: "sheet",
      lines: ["Client · Invoices · Total", "Acme Corp · 14 · $48,200", "Northwind · 9 · $31,750", "Globex · 11 · $22,400", "Initech · 6 · $9,900"]
    }
  },
  {
    id: "launch",
    title: "Draft launch post",
    group: "marketing",
    meta: "Mon",
    prompt: "Draft a LinkedIn post announcing the new billing page, in our brand voice.",
    steps: [
      { mark: <SkillMark className="h-4 w-4" />, text: "Used your Brand voice skill" },
      { mark: fileIcon, text: "Read launch-notes.md", duration: "0.2s" },
      { mark: fileIcon, text: "Wrote launch-post.md", duration: "0.5s" }
    ],
    worked: "Worked for 1s",
    reply: "Here's a first draft. It's under 120 words and ends with the link to the changelog.",
    artifact: {
      name: "launch-post.md",
      meta: "Draft · 112 words",
      icon: "doc",
      lines: ["Billing just got simpler.", "One page for plans, seats and invoices.", "Change your plan in two clicks, download any invoice, see what's next.", "Read the changelog →"]
    }
  },
  {
    id: "lisbon",
    title: "Plan Lisbon trip",
    group: "personal",
    meta: "Aug",
    prompt: "Plan three days in Lisbon in October: neighborhoods, one day trip, and a rough budget.",
    steps: [{ mark: fileIcon, text: "Wrote lisbon-plan.md", duration: "0.6s" }],
    worked: "Worked for 1s",
    reply: "Day 1 Alfama and Baixa, day 2 a day trip to Sintra, day 3 Belém and LX Factory. About €650 for two, before flights.",
    artifact: {
      name: "lisbon-plan.md",
      meta: "Plan · 3 days",
      icon: "doc",
      lines: ["Day 1: Alfama, Baixa, sunset at Miradouro da Graça", "Day 2: Sintra (train from Rossio, 40 min)", "Day 3: Belém, LX Factory", "Budget: ~€650 for two"]
    }
  }
];

export const SUGGESTIONS: { label: string; sessionId: SessionId }[] = [
  { label: "Summarize my week", sessionId: "weekly" },
  { label: "Clean up a spreadsheet", sessionId: "invoices" },
  { label: "Draft a document", sessionId: "launch" },
  { label: "Prep a board slide", sessionId: "q3" }
];

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

const MODELS = ["Claude Sonnet 5", "GPT-5", "Gemini 3 Pro", "DeepSeek V4 Pro"];
const RUN_MODES = ["Ask before actions", "Workspace defaults", "Keep going"];
const PLUS_ITEMS = [
  { id: "file", label: "Attach a file", prefill: "Use the attached file to " },
  { id: "skill", label: "Skills", prefill: "Use my Weekly update skill to " },
  { id: "connector", label: "Connectors", prefill: "Search Linear for " }
];

type ComposerProps = {
  onSend: (text: string) => void;
  onStop?: () => void;
  busy: boolean;
  placeholder?: string;
  children?: ReactNode;
};

export function Composer({ onSend, onStop, busy, placeholder = "Describe your task...", children }: ComposerProps) {
  const [text, setText] = useState("");
  const [model, setModel] = useState(MODELS[0]);
  const [mode, setMode] = useState(RUN_MODES[0]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="w-full max-w-[664px] rounded-2xl bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.1),0_8px_24px_-12px_rgba(1,22,39,0.18)]">
      {children}
      <div className="flex flex-col gap-3 px-4 pb-3 pt-3.5">
        <label className="sr-only" htmlFor="demo-composer">Describe your task</label>
        <textarea
          id="demo-composer"
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          className="min-h-[22px] w-full resize-none bg-transparent text-sm text-[#111827] placeholder:text-[#9AA2AE] focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <DemoMenu
            label="Add files, skills, connectors, and more"
            trigger={<Plus size={14} aria-hidden="true" />}
            items={PLUS_ITEMS.map((item) => ({ id: item.id, label: item.label }))}
            onSelect={(id) => {
              const item = PLUS_ITEMS.find((entry) => entry.id === id);
              if (item) setText(item.prefill);
              inputRef.current?.focus();
            }}
            triggerClassName={`flex h-7 w-7 items-center justify-center rounded-full text-[#4B5563] shadow-[0_0_0_1px_#E5E7EB] hover:bg-[#F7F8FA] ${focusRing}`}
          />
          <DemoMenu
            label="Change model"
            title="Model"
            trigger={<span>{model} · High</span>}
            items={MODELS.map((entry) => ({ id: entry, label: entry, selected: entry === model }))}
            onSelect={setModel}
            triggerClassName={`flex h-7 items-center rounded-full bg-[#F3F4F6] px-2.5 text-xs text-[#374151] hover:bg-[#ECEEF1] ${focusRing}`}
          />
          <div className="hidden sm:block">
            <DemoMenu
              label="How should OpenWork handle approvals?"
              title="How should OpenWork handle approvals?"
              trigger={<span>{mode}</span>}
              items={RUN_MODES.map((entry) => ({ id: entry, label: entry, selected: entry === mode }))}
              onSelect={setMode}
              triggerClassName={`flex h-7 items-center rounded-full bg-[#F3F4F6] px-2.5 text-xs text-[#374151] hover:bg-[#ECEEF1] ${focusRing}`}
            />
          </div>
          <span className="flex-1" />
          <button
            type="button"
            onClick={busy ? onStop : send}
            disabled={!busy && !text.trim()}
            aria-label={busy ? "Stop" : "Run task"}
            className={`flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[var(--lp-ink)] text-white transition-opacity duration-150 disabled:opacity-30 ${focusRing}`}
          >
            {busy ? <Square size={11} fill="currentColor" aria-hidden="true" /> : <ArrowUp size={14} strokeWidth={2} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chat pane                                                           */
/* ------------------------------------------------------------------ */

export type ExtraMessage = { role: "user" | "assistant"; text: string };
export type ApprovalState = "pending" | "done" | "denied";

type ChatPaneProps = {
  session: DemoSession;
  extras: ExtraMessage[];
  approval: ApprovalState;
  onApproval: (state: ApprovalState) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
};

export function ChatPane({ session, extras, approval, onApproval, onSend, onStop, busy }: ChatPaneProps) {
  const [stepsOpen, setStepsOpen] = useState(true);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setArtifactOpen(false);
    setStepsOpen(true);
  }, [session.id]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [extras.length, busy, approval]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center border-b border-[#F0F1F3] px-5">
        <span className="truncate text-[13px] font-medium text-[#111827]">{session.title}</span>
      </div>
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pb-4 pt-7">
        <div className="flex w-full max-w-[640px] flex-col gap-[18px]">
          <UserBubble text={session.prompt} />
          {session.custom ? (
            busy && extras.length === 0 ? null : <PreviewReply />
          ) : (
            <>
              {session.steps.length > 0 ? (
                <div className="flex flex-col">
                  <button
                    type="button"
                    aria-expanded={stepsOpen}
                    onClick={() => setStepsOpen((current) => !current)}
                    className={`flex h-7 items-center gap-1.5 self-start rounded-md text-xs text-[#6B7280] hover:text-[#111827] ${focusRing}`}
                  >
                    <ChevronRight size={13} aria-hidden="true" className={`transition-transform duration-150 motion-reduce:transition-none ${stepsOpen ? "rotate-90" : ""}`} />
                    {session.worked} · {session.steps.length} {session.steps.length === 1 ? "step" : "steps"}
                  </button>
                  {stepsOpen ? (
                    <div className="mt-1 flex flex-col border-l border-[var(--lp-border)] pl-3">
                      {session.steps.map((step) => (
                        <div key={step.text} className="flex min-h-7 items-center gap-2.5">
                          <span className="flex w-4 shrink-0" aria-hidden="true">{step.mark}</span>
                          <span className="flex-1 text-[13px] text-[#374151]">{step.text}</span>
                          <span className="w-10 shrink-0 text-right text-xs text-[#8A93A0]">{step.duration}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <p className="text-sm leading-[22px] text-[#111827]">{session.reply}</p>
              {session.artifact ? (
                <button
                  type="button"
                  onClick={() => setArtifactOpen(true)}
                  className={`flex items-center gap-3 rounded-xl px-3.5 py-3 text-left shadow-[0_0_0_1px_rgba(1,22,39,0.08)] transition-colors duration-150 hover:bg-[#FAFBFC] ${focusRing}`}
                >
                  <ArtifactIcon kind={session.artifact.icon} />
                  <span className="flex flex-1 flex-col">
                    <span className="text-[13px] font-medium text-[#111827]">{session.artifact.name}</span>
                    <span className="text-xs text-[#6B7280]">{session.artifact.meta}</span>
                  </span>
                  <span className="text-xs text-[#374151]">Open</span>
                </button>
              ) : null}
              {session.approval && approval !== "pending" ? (
                <div className="flex items-center gap-2 text-xs text-[#4B5563]">
                  <SlackMark className="h-3.5 w-3.5" />
                  <span>{approval === "done" ? session.approval.done : "Not posted"}</span>
                  <button type="button" onClick={() => onApproval("pending")} className={`rounded text-[#111827] underline underline-offset-2 ${focusRing}`}>
                    Undo
                  </button>
                </div>
              ) : null}
            </>
          )}
          {extras.map((message, index) =>
            message.role === "user" ? <UserBubble key={index} text={message.text} /> : <PreviewReply key={index} />
          )}
          {busy ? <span className="lp-demo-shimmer text-[13px] text-[#6B7280]">Working…</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 justify-center px-4 pb-5 pt-2">
        <Composer onSend={onSend} onStop={onStop} busy={busy}>
          {session.approval && approval === "pending" && !session.custom ? (
            <div className="flex flex-wrap items-center gap-3 border-b border-[#F0F1F3] px-4 py-3.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F7F8FA]">
                <SlackMark className="h-[18px] w-[18px]" />
              </span>
              <span className="flex min-w-[180px] flex-1 flex-col">
                <span className="text-[13px] font-medium text-[#111827]">{session.approval.title}</span>
                <span className="text-xs text-[#6B7280]">{session.approval.detail}</span>
              </span>
              <button type="button" onClick={() => onApproval("denied")} className={`flex h-[30px] items-center rounded-lg px-3 text-xs text-[#374151] shadow-[0_0_0_1px_#E5E7EB] hover:bg-[#F7F8FA] ${focusRing}`}>
                Deny
              </button>
              <button type="button" onClick={() => onApproval("done")} className={`flex h-[30px] items-center gap-2 rounded-lg bg-[var(--lp-ink)] px-3 text-xs text-white hover:opacity-90 ${focusRing}`}>
                {session.approval.action} <span className="text-[11px] opacity-60" aria-hidden="true">⏎</span>
              </button>
            </div>
          ) : null}
        </Composer>
      </div>

      {artifactOpen && session.artifact ? (
        <aside
          aria-label={session.artifact.name}
          className="absolute inset-y-0 right-0 z-10 flex w-full flex-col border-l border-[#EEF0F3] bg-white shadow-[-16px_0_32px_-24px_rgba(1,22,39,0.25)] sm:w-[320px]"
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[#F0F1F3] px-4">
            <ArtifactIcon kind={session.artifact.icon} small />
            <span className="flex-1 truncate text-[13px] font-medium text-[#111827]">{session.artifact.name}</span>
            <button type="button" aria-label="Close preview" onClick={() => setArtifactOpen(false)} className={`flex h-7 w-7 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F3F4F6] ${focusRing}`}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-col gap-2.5 overflow-y-auto p-4">
            {session.artifact.lines.map((line, index) => (
              <p key={line} className={index === 0 ? "text-[15px] font-semibold text-[#111827]" : "text-[13px] leading-5 text-[#374151]"}>
                {line}
              </p>
            ))}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return <p className="max-w-[460px] self-end whitespace-pre-wrap rounded-2xl bg-[#F1F2F4] px-3.5 py-2.5 text-sm leading-[21px] text-[#111827]">{text}</p>;
}

function PreviewReply() {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm leading-[22px] text-[#111827]">
        This is a preview, so I can&apos;t reach your files or tools from here. In the app I&apos;d start on this right away.
      </p>
      <DownloadLink className="lp-pill-primary lp-pill-sm">Download OpenWork</DownloadLink>
    </div>
  );
}

function ArtifactIcon({ kind, small = false }: { kind: Artifact["icon"]; small?: boolean }) {
  const icon =
    kind === "sheet" ? <FileSpreadsheet size={16} strokeWidth={1.5} className="text-[#047857]" /> : kind === "slides" ? <Presentation size={16} strokeWidth={1.5} className="text-[#B45309]" /> : <FileText size={16} strokeWidth={1.5} className="text-[#4B5563]" />;
  if (small) return <span aria-hidden="true">{icon}</span>;
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--lp-tonal)]" aria-hidden="true">{icon}</span>;
}

/* ------------------------------------------------------------------ */
/* New session                                                         */
/* ------------------------------------------------------------------ */

type NewSessionPaneProps = {
  onPick: (sessionId: SessionId) => void;
  onSend: (text: string) => void;
};

export function NewSessionPane({ onPick, onSend }: NewSessionPaneProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 py-8">
      <h3 className="text-center text-[22px] font-medium tracking-[-0.02em] text-[#111827]">What do you need done?</h3>
      <Composer onSend={onSend} busy={false} />
      <div className="grid w-full max-w-[664px] grid-cols-2 gap-2 sm:grid-cols-4">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.label}
            type="button"
            onClick={() => onPick(suggestion.sessionId)}
            className={`rounded-xl px-3 py-3 text-left text-[13px] text-[#374151] shadow-[0_0_0_1px_rgba(1,22,39,0.08)] transition-colors duration-150 hover:bg-[#F7F8FA] hover:text-[#111827] ${focusRing}`}
          >
            {suggestion.label}
          </button>
        ))}
      </div>
    </div>
  );
}
