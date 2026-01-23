import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";

import type { Session } from "@opencode-ai/sdk/v2/client";

import type { DemoSequence, MessageWithParts, TodoItem, WorkspaceDisplay } from "./types";
import { deriveArtifacts, deriveWorkingFiles } from "./utils";

export function createDemoState(options: {
  sessions: Accessor<Session[]>;
  sessionStatusById: Accessor<Record<string, string>>;
  messages: Accessor<MessageWithParts[]>;
  todos: Accessor<TodoItem[]>;
  selectedSessionId: Accessor<string | null>;
}) {
  const [demoMode, setDemoMode] = createSignal(false);
  const [demoSequence, setDemoSequence] = createSignal<DemoSequence>("cold-open");

  const [demoSessions, setDemoSessions] = createSignal<Session[]>([]);
  const [demoSessionStatusById, setDemoSessionStatusById] = createSignal<Record<string, string>>({});
  const [demoMessages, setDemoMessages] = createSignal<MessageWithParts[]>([]);
  const [demoTodos, setDemoTodos] = createSignal<TodoItem[]>([]);
  const [demoArtifacts, setDemoArtifacts] = createSignal<ReturnType<typeof deriveArtifacts>>([]);
  const [demoSelectedSessionId, setDemoSelectedSessionId] = createSignal<string | null>(null);
  const [demoWorkingFiles, setDemoWorkingFiles] = createSignal<string[]>([]);
  const [demoAuthorizedDirs, setDemoAuthorizedDirs] = createSignal<string[]>([]);
  const [demoActiveWorkspaceDisplay, setDemoActiveWorkspaceDisplay] = createSignal<WorkspaceDisplay>({
    id: "demo",
    name: "Demo",
    path: "~/OpenWork Demo",
    preset: "starter",
    workspaceType: "local",
  });

  const isDemoMode = createMemo(() => demoMode());

  function setDemoSequenceState(sequence: DemoSequence) {
    const now = Date.now();

    setDemoSelectedSessionId(null);

    const makeToolPart = (tool: string, title: string, output: string, path?: string) =>
      ({
        id: `tool-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
        type: "tool",
        sessionID: `demo-${sequence}`,
        messageID: `msg-${sequence}-assistant`,
        tool,
        state: {
          status: "completed",
          title,
          output,
          ...(path ? { path } : {}),
        },
      } as any);

    const makeTextPart = (text: string) =>
      ({
        id: `text-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
        type: "text",
        sessionID: `demo-${sequence}`,
        messageID: `msg-${sequence}-assistant`,
        text,
      } as any);

    const baseSession = {
      id: `demo-${sequence}`,
      slug: "demo",
      title: "Demo run",
      directory: "~/OpenWork Demo",
      time: { updated: now },
    } as any;

    const baseUser = {
      id: `msg-${sequence}-user`,
      sessionID: baseSession.id,
      role: "user",
      time: { created: now - 120000 },
    } as any;

    const baseAssistant = {
      id: `msg-${sequence}-assistant`,
      sessionID: baseSession.id,
      role: "assistant",
      time: { created: now - 90000 },
    } as any;

    if (sequence === "cold-open") {
      const parts = [
        makeTextPart("Scheduled weekly finance recap and prepared the grocery draft."),
        makeToolPart("schedule_job", "Scheduled weekly finance recap", "Next run: Monday 9:00 AM"),
        makeToolPart(
          "read",
          "Summarized meeting notes",
          "Generated notes summary: highlights + follow-ups.",
          "notes/summary.md",
        ),
        makeToolPart("write", "Prepared grocery order", "Cart ready with 14 items.", "home/grocery-list.md"),
      ];

      const messages = [
        { info: baseUser, parts: [{ type: "text", text: "Run the weekly stack." } as any] },
        { info: baseAssistant, parts },
      ];

      setDemoActiveWorkspaceDisplay({
        id: "demo",
        name: "Home",
        path: "~/OpenWork Demo",
        preset: "starter",
        workspaceType: "local",
      });
      setDemoSessions([baseSession]);
      setDemoSessionStatusById({ [baseSession.id]: "completed" });
      setDemoMessages(messages);
      setDemoTodos([
        { id: "cold-1", content: "Schedule recurring recap", status: "completed", priority: "high" },
        { id: "cold-2", content: "Summarize notes", status: "completed", priority: "medium" },
        { id: "cold-3", content: "Prepare grocery order", status: "completed", priority: "medium" },
      ]);
      setDemoAuthorizedDirs(["~/OpenWork Demo", "~/Documents/Notes"]);
      setDemoSelectedSessionId(baseSession.id);
      const derived = deriveArtifacts(messages as MessageWithParts[]);
      setDemoArtifacts(derived);
      setDemoWorkingFiles(deriveWorkingFiles(derived));
      return;
    }

    if (sequence === "scheduler") {
      const parts = [
        makeTextPart("Scheduled finance recap and weekly report export."),
        makeToolPart("schedule_job", "Weekly finance recap", "Next run: Monday 9:00 AM"),
        makeToolPart("schedule_job", "Weekly report export", "Next run: Friday 4:00 PM"),
      ];

      const messages = [
        { info: baseUser, parts: [{ type: "text", text: "Set up weekly finance jobs." } as any] },
        { info: baseAssistant, parts },
      ];

      setDemoActiveWorkspaceDisplay({
        id: "demo-finance",
        name: "Finance",
        path: "~/OpenWork Demo/finance",
        preset: "starter",
        workspaceType: "local",
      });
      setDemoSessions([{ ...baseSession, title: "Weekly finance recap" }]);
      setDemoSessionStatusById({ [baseSession.id]: "completed" });
      setDemoMessages(messages);
      setDemoTodos([
        { id: "sched-1", content: "Create weekly recap", status: "completed", priority: "high" },
        { id: "sched-2", content: "Schedule export", status: "completed", priority: "medium" },
      ]);
      setDemoAuthorizedDirs(["~/OpenWork Demo/finance"]);
      setDemoSelectedSessionId(baseSession.id);
      const derived = deriveArtifacts(messages as MessageWithParts[]);
      setDemoArtifacts(derived);
      setDemoWorkingFiles(deriveWorkingFiles(derived));
      return;
    }

    if (sequence === "summaries") {
      const parts = [
        makeTextPart("Compiled the latest meeting notes and flagged action items."),
        makeToolPart(
          "read",
          "Summarized Q1 planning notes",
          "Summary saved with 6 action items.",
          "notes/summary.md",
        ),
        makeToolPart(
          "write",
          "Created follow-up list",
          "Action items captured in follow-ups.md",
          "notes/follow-ups.md",
        ),
      ];

      const messages = [
        { info: baseUser, parts: [{ type: "text", text: "Summarize the latest notes." } as any] },
        { info: baseAssistant, parts },
      ];

      setDemoActiveWorkspaceDisplay({
        id: "demo-notes",
        name: "Notes",
        path: "~/OpenWork Demo/notes",
        preset: "starter",
        workspaceType: "local",
      });
      setDemoSessions([{ ...baseSession, title: "Notes summary" }]);
      setDemoSessionStatusById({ [baseSession.id]: "completed" });
      setDemoMessages(messages);
      setDemoTodos([
        { id: "sum-1", content: "Read recent notes", status: "completed", priority: "high" },
        { id: "sum-2", content: "Create summary", status: "completed", priority: "medium" },
        { id: "sum-3", content: "Publish follow-ups", status: "completed", priority: "medium" },
      ]);
      setDemoAuthorizedDirs(["~/OpenWork Demo/notes"]);
      setDemoSelectedSessionId(baseSession.id);
      const derived = deriveArtifacts(messages as MessageWithParts[]);
      setDemoArtifacts(derived);
      setDemoWorkingFiles(deriveWorkingFiles(derived));
      return;
    }

    const parts = [
      makeTextPart("Prepared a checkout-ready grocery cart from this week's meal plan."),
      makeToolPart("read", "Parsed meal plan", "Identified 14 ingredients needed.", "home/meal-plan.md"),
      makeToolPart("write", "Generated grocery list", "Grocery list ready for review.", "home/grocery-list.md"),
      makeToolPart("tool.browser", "Built Instacart draft", "Cart ready with 14 items."),
    ];

    const messages = [
      { info: baseUser, parts: [{ type: "text", text: "Prep grocery order for this week." } as any] },
      { info: baseAssistant, parts },
    ];

    setDemoActiveWorkspaceDisplay({
      id: "demo-home",
      name: "Home",
      path: "~/OpenWork Demo/home",
      preset: "starter",
      workspaceType: "local",
    });
    setDemoSessions([{ ...baseSession, title: "Grocery order" }]);
    setDemoSessionStatusById({ [baseSession.id]: "completed" });
    setDemoMessages(messages);
    setDemoTodos([
      { id: "gro-1", content: "Read meal plan", status: "completed", priority: "high" },
      { id: "gro-2", content: "Generate list", status: "completed", priority: "medium" },
      { id: "gro-3", content: "Prepare checkout cart", status: "completed", priority: "medium" },
    ]);
    setDemoAuthorizedDirs(["~/OpenWork Demo/home"]);
    setDemoSelectedSessionId(baseSession.id);
    const derived = deriveArtifacts(messages as MessageWithParts[]);
    setDemoArtifacts(derived);
    setDemoWorkingFiles(deriveWorkingFiles(derived));
  }

  const artifacts = createMemo(() => deriveArtifacts(options.messages()));
  const workingFiles = createMemo(() => deriveWorkingFiles(artifacts()));

  const activeSessionId = createMemo(() => (isDemoMode() ? demoSelectedSessionId() : options.selectedSessionId()));
  const activeSessions = createMemo(() => {
    if (!isDemoMode()) return options.sessions();
    return demoSessions()
      .slice()
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0) || a.id.localeCompare(b.id));
  });
  const activeSessionStatusById = createMemo(() =>
    isDemoMode() ? demoSessionStatusById() : options.sessionStatusById(),
  );
  const activeMessages = createMemo(() => (isDemoMode() ? demoMessages() : options.messages()));
  const activeTodos = createMemo(() => (isDemoMode() ? demoTodos() : options.todos()));
  const activeArtifacts = createMemo(() => (isDemoMode() ? demoArtifacts() : artifacts()));
  const activeWorkingFiles = createMemo(() => (isDemoMode() ? demoWorkingFiles() : workingFiles()));

  const selectDemoSession = (sessionId: string) => {
    setDemoSelectedSessionId(sessionId);
  };

  const renameDemoSession = (sessionId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setDemoSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              title: trimmed,
              time: { ...session.time, updated: Date.now() },
            }
          : session,
      ),
    );
  };

  createEffect(() => {
    if (!isDemoMode()) return;
    setDemoSequenceState(demoSequence());
  });

  return {
    demoMode,
    setDemoMode,
    demoSequence,
    setDemoSequence,
    isDemoMode,
    demoAuthorizedDirs,
    demoActiveWorkspaceDisplay,
    activeSessionId,
    activeSessions,
    activeSessionStatusById,
    activeMessages,
    activeTodos,
    activeArtifacts,
    activeWorkingFiles,
    selectDemoSession,
    renameDemoSession,
    setDemoSelectedSessionId,
    demoSelectedSessionId,
  };
}
