"use client";

import { ChevronRight, Clock3, Folder, LayoutGrid, SquarePen } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AutomationsView } from "./lp-demo-automations";
import {
  ChatPane,
  INITIAL_SESSIONS,
  NewSessionPane,
  type ApprovalState,
  type DemoSession,
  type ExtraMessage,
  type SessionId
} from "./lp-demo-chat";
import { LibraryView } from "./lp-demo-library";
import { focusRing } from "./lp-demo-ui";
import { OpenWorkMark } from "./openwork-mark";

type View = { kind: "session"; id: SessionId } | { kind: "new" } | { kind: "library" } | { kind: "automations" };

type Props = {
  /** Show macOS window controls (desktop) or not (inside a browser). */
  windowControls?: boolean;
};

const PREVIEW_DELAY_MS = 900;

/** The OpenWork app as a working preview: every session, view and control responds. */
export function LpDemoDesktop({ windowControls = true }: Props) {
  const [sessions, setSessions] = useState<DemoSession[]>(INITIAL_SESSIONS);
  const [view, setView] = useState<View>({ kind: "session", id: "weekly" });
  const [extras, setExtras] = useState<Record<SessionId, ExtraMessage[]>>({});
  const [approvals, setApprovals] = useState<Record<SessionId, ApprovalState>>({});
  const [busy, setBusy] = useState<SessionId | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const openSession = (id: SessionId) => {
    setView({ kind: "session", id });
    setSessions((current) => current.map((session) => (session.id === id ? { ...session, unread: false } : session)));
  };

  const reply = (id: SessionId) => {
    setBusy(id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setExtras((current) => ({ ...current, [id]: [...(current[id] ?? []), { role: "assistant", text: "" }] }));
      setBusy(null);
      timer.current = null;
    }, PREVIEW_DELAY_MS);
  };

  const sendInSession = (id: SessionId, text: string) => {
    setExtras((current) => ({ ...current, [id]: [...(current[id] ?? []), { role: "user", text }] }));
    reply(id);
  };

  const startSession = (text: string) => {
    const id = `custom-${sessions.length}-${text.length}`;
    const title = text.length > 34 ? `${text.slice(0, 32).trimEnd()}…` : text;
    setSessions((current) => [
      ...current.filter((session) => session.group !== "marketing"),
      { id, title, group: "marketing", meta: "now", prompt: text, steps: [], reply: "", custom: true },
      ...current.filter((session) => session.group === "marketing").map((session) => (session.meta === "now" ? { ...session, meta: "1m" } : session))
    ]);
    setView({ kind: "session", id });
    setBusy(id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setBusy(null);
      timer.current = null;
    }, PREVIEW_DELAY_MS);
  };

  const activeSession = view.kind === "session" ? sessions.find((session) => session.id === view.id) : undefined;
  const groupSessions = (group: DemoSession["group"]) => sessions.filter((session) => session.group === group);

  const mobileTabs: { key: View["kind"]; label: string; select: () => void }[] = [
    { key: "session", label: "Chat", select: () => openSession(activeSession?.id ?? "weekly") },
    { key: "library", label: "Library", select: () => setView({ kind: "library" }) },
    { key: "automations", label: "Automations", select: () => setView({ kind: "automations" }) }
  ];

  return (
    <div className="flex h-full min-h-0 w-full">
      <aside aria-label="OpenWork sidebar" className="hidden w-[236px] shrink-0 flex-col bg-[#ECEDEF] px-2 py-3 md:flex">
        {windowControls ? (
          <div className="flex h-6 items-center gap-[7px] px-2" aria-hidden="true">
            <span className="h-[11px] w-[11px] rounded-full bg-[#FF5F57]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#FEBC2E]" />
            <span className="h-[11px] w-[11px] rounded-full bg-[#28C840]" />
          </div>
        ) : null}
        <div className={`${windowControls ? "mt-3.5" : "mt-1"} flex h-8 items-center gap-2 px-2.5`}>
          <OpenWorkMark className="h-4 w-5" />
          <span className="text-[15px] font-medium text-[var(--lp-ink)]">OpenWork</span>
        </div>
        <nav className="mt-2 flex flex-col gap-0.5" aria-label="App views">
          <NavRow icon={<SquarePen size={16} strokeWidth={1.5} />} label="New session" hint="⌘N" selected={view.kind === "new"} onSelect={() => setView({ kind: "new" })} />
          <NavRow icon={<Clock3 size={16} strokeWidth={1.5} />} label="Automations" selected={view.kind === "automations"} onSelect={() => setView({ kind: "automations" })} />
          <NavRow icon={<LayoutGrid size={16} strokeWidth={1.5} />} label="Library" selected={view.kind === "library"} onSelect={() => setView({ kind: "library" })} />
        </nav>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-2.5 mb-1.5 mt-[18px] text-[11px] text-[#6B7280]">Pinned</div>
          {groupSessions("pinned").map((session) => (
            <SessionRow key={session.id} session={session} selected={activeSession?.id === session.id} onSelect={() => openSession(session.id)} />
          ))}
          <div className="mx-2.5 mb-1.5 mt-4 text-[11px] text-[#6B7280]">Workspaces</div>
          {(["marketing", "personal"] satisfies DemoSession["group"][]).map((group) => {
            const isCollapsed = collapsed[group] ?? false;
            return (
              <div key={group} className="flex flex-col">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((current) => ({ ...current, [group]: !isCollapsed }))}
                  className={`group flex h-[30px] items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-[#E3E5E8] ${focusRing}`}
                >
                  <Folder size={16} strokeWidth={1.5} className="text-[#4B5563]" aria-hidden="true" />
                  <span className="flex-1 text-[13px] font-medium text-[#1F2937]">{group === "marketing" ? "Marketing" : "Personal"}</span>
                  <ChevronRight size={13} aria-hidden="true" className={`text-[#8A93A0] transition-transform duration-150 motion-reduce:transition-none ${isCollapsed ? "" : "rotate-90"}`} />
                </button>
                {isCollapsed
                  ? null
                  : groupSessions(group).map((session) => (
                      <SessionRow key={session.id} session={session} selected={activeSession?.id === session.id} onSelect={() => openSession(session.id)} />
                    ))}
              </div>
            );
          })}
        </div>
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-t border-[rgba(1,22,39,0.08)] px-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--lp-ink)] text-[10px] font-semibold text-white">SK</span>
          <span className="flex flex-col leading-tight">
            <span className="text-xs font-medium text-[#1F2937]">Sam K.</span>
            <span className="text-[11px] text-[#6B7280]">OpenWork Cloud</span>
          </span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-white">
        <div className="flex gap-1 border-b border-[#F0F1F3] p-2 md:hidden" role="group" aria-label="App views">
          {mobileTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              aria-pressed={view.kind === tab.key || (tab.key === "session" && view.kind === "new")}
              onClick={tab.select}
              className={`h-8 flex-1 rounded-lg text-xs ${focusRing} ${view.kind === tab.key || (tab.key === "session" && view.kind === "new") ? "bg-[var(--lp-tonal)] font-medium text-[var(--lp-ink)]" : "text-[var(--lp-muted)]"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {view.kind === "new" ? <NewSessionPane onPick={openSession} onSend={startSession} /> : null}
        {activeSession ? (
          <ChatPane
            session={activeSession}
            extras={extras[activeSession.id] ?? []}
            approval={approvals[activeSession.id] ?? "pending"}
            onApproval={(state) => setApprovals((current) => ({ ...current, [activeSession.id]: state }))}
            onSend={(text) => sendInSession(activeSession.id, text)}
            onStop={() => {
              if (timer.current) clearTimeout(timer.current);
              timer.current = null;
              setBusy(null);
            }}
            busy={busy === activeSession.id}
          />
        ) : null}
        {view.kind === "library" ? <LibraryView /> : null}
        {view.kind === "automations" ? <AutomationsView /> : null}
      </div>
    </div>
  );
}

function NavRow({ icon, label, hint, selected, onSelect }: { icon: ReactNode; label: string; hint?: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-150 ${focusRing} ${selected ? "bg-[#DCDEE2] font-medium text-[var(--lp-ink)]" : "text-[#374151] hover:bg-[#E3E5E8]"}`}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint ? <span className="text-[11px] text-[#8A93A0]">{hint}</span> : null}
    </button>
  );
}

function SessionRow({ session, selected, onSelect }: { session: DemoSession; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={`flex h-[30px] shrink-0 items-center rounded-lg pl-[34px] pr-2.5 text-left text-[13px] text-[#1F2937] transition-colors duration-150 ${focusRing} ${selected ? "bg-[#DCDEE2] font-medium" : "hover:bg-[#E3E5E8]"}`}
    >
      <span className="flex-1 truncate">{session.title}</span>
      {session.unread ? <span className="h-1.5 w-1.5 rounded-full bg-[#3B82F6]" aria-label="Unread" /> : <span className="text-[11px] text-[#8A93A0]">{session.meta}</span>}
    </button>
  );
}
