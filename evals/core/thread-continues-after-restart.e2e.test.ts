import { basename } from "node:path";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { assertWitnessModel, restartedThreadWorld, type RestartMode } from "../worlds/thread-restart.ts";

/**
 * A person restarts OpenWork (crash, force quit, or a normal quit) while a
 * thread is still working, reopens that thread, and types the next message.
 * Whatever state the interrupted turn was left in, and however slowly the
 * cold engine returns the thread's complete history, the typed message must be
 * accepted exactly once and answered, and must never bounce back into the
 * composer as an unsent draft.
 */
const test = spec.world(restartedThreadWorld, {
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "The renderer, embedded server, engine, and its task-recovery journal die and relaunch together only in the Electron main process; a restart of one Electron profile is the state under test.",
  },
  timeout: 600_000,
});

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an engine record");
  return Object.fromEntries(Object.entries(value));
};

/** Longer than the renderer's request timeout for one uncapped history read. */
/** Unsent words typed before a quit: one queued follow-up and a draft after it. */
const QUEUED = "Then publish the release notes";
const DRAFT = "Draft typed before the restart";

const cases: { title: string; mode: RestartMode }[] = [
  { title: "a thread interrupted by a crash accepts the next typed message after relaunch", mode: "kill" },
  { title: "a thread interrupted by a quit accepts the next typed message after relaunch", mode: "quit" },
];

for (const { title, mode } of cases) {
  test(title, async ({ world, user, probe, agent, step, evidence }) => {
    user = user.on(world.app);
    probe = probe.on(world.app);
    agent = agent.on(world.app);
    const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode2/api`;
    const read = async (path: string, envelope = false): Promise<unknown> => {
      const response = await probe.desktopApi(`${mount}${path}`);
      expect(response.status).toBe(200);
      return envelope ? response.body : record(response.body).data;
    };
    const messages = async () => {
      const value: unknown[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let paged = false;
      do {
        const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
        const page = record(await read(`/session/${world.session.sessionId}/message?${query}`, true));
        if (!Array.isArray(page.data)) throw new Error("Expected engine messages");
        value.push(...page.data);
        paged ||= "cursor" in page;
        const next = page.cursor ? record(page.cursor).next : null;
        cursor = typeof next === "string" ? next : undefined;
        if (cursor && seen.has(cursor)) throw new Error("Engine message cursor did not advance");
        if (cursor) seen.add(cursor);
      } while (cursor);
      // Native pages are newest first; the continuity claim compares history
      // in chronological order, including across page boundaries.
      return (paged ? value.toReversed() : value).map((entry: unknown) => {
        const message = record(entry);
        // Native user messages store text on the message; assistant replies
        // carry content parts. Context entries also include model-only rows.
        const parts = Array.isArray(message.content) ? message.content
          : typeof message.text === "string" ? [{ type: "text", text: message.text }] : [];
        return { id: String(message.id), role: String(message.type), parts: parts.map(record) };
      });
    };
    const userTexts = (items: Awaited<ReturnType<typeof messages>>) => items.filter((message) => message.role === "user")
      .map((message) => message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join(""));
    const active = async () => {
      const statuses = record(await read("/session/active"));
      const status = statuses[world.session.sessionId];
      return status !== undefined && ["running", "busy", "retry"].includes(String(record(status).type));
    };
    const onThread = async () => (await probe.hash()).includes(`/session/${world.session.sessionId}`);
    const composerSettled = async () => {
      // The thread view rehydrates its draft shortly after opening; act only
      // once the composer has been editable and empty for 750 ms.
      let emptySince: number | null = null;
      await probe.eventually(async () => {
        const state = await probe.composer();
        if (!state.composerEditable || state.draftText !== "") { emptySince = null; return false; }
        emptySince ??= Date.now();
        return Date.now() - emptySince >= 750;
      }, { within: 30_000, intervalMs: 250, label: "the composer is ready", until: Boolean });
    };
    /** The claim: the person types the message and presses Enter. */
    const typeAndSend = async (surface: typeof world.app, text: string) => {
      await assertWitnessModel(surface);
      await composerSettled();
      try {
        await user.type("composer", text, { verify: true });
      } catch {
        // A late rehydration can swallow the first keystrokes; type once more.
        await composerSettled();
        await user.type("composer", text, { verify: true, replace: true });
      }
      await user.press("Enter");
    };
    /** Arrangement only: the turn that will be interrupted goes through the app's own composer seams. */
    const arrangeTurn = async (surface: typeof world.app, text: string) => {
      await assertWitnessModel(surface);
      await composerSettled();
      await agent.send(text);
    };
    const reopenThread = async (expectedText: string) => {
      // The app restores where the person left off; when it cannot, they click
      // through the sidebar the way they always do.
      const restored = await probe.eventually(onThread, { within: 15_000, label: "the thread route is restored", until: Boolean }).catch(() => false);
      if (!restored) {
        const titleVisible = await probe.eventually(() => probe.has(world.session.title), { within: 5_000, label: "the thread is listed", until: Boolean }).catch(() => false);
        if (!titleVisible) await user.click({ text: basename(world.workspacePath) });
        await user.click({ text: world.session.title });
      }
      await probe.eventually(onThread, { within: 30_000, label: "the thread is selected", until: Boolean });
      await user.see({ text: expectedText }, { timeoutMs: 60_000 });
    };

    if (mode === "kill") {
      // A crash also loses the renderer's most recent uncommitted storage. A
      // person's model choice is days old by then; commit it with one ordinary
      // quit so the crash below exercises thread continuity, not preferences.
      const settled = await step("preferences were committed by an earlier ordinary quit", () => world.restart("quit"));
      user = user.on(settled);
      probe = probe.on(settled);
      agent = agent.on(settled);
      await reopenThread(world.session.title);
    }

    await step("the thread is running a long tool when the desktop goes away", async () => {
      if (!await onThread()) await user.click({ text: world.session.title });
      await probe.eventually(onThread, { within: 30_000, label: "the thread is selected", until: Boolean });
      await arrangeTurn(world.app, world.prompts.interrupted);
      await probe.eventually(async () => ({ active: await active(), messages: await messages() }), {
        within: 60_000, label: "the engine is running the unfinished tool",
        until: (state) => state.active && state.messages.some((message) => message.parts.some((part) => part.type === "tool" && record(part.state).status === "running")),
      });
    });

    // A normal quit commits renderer storage, so unsent words must come back.
    const keepsUnsent = mode === "quit";
    if (keepsUnsent) await step("while it runs, the person queues a follow-up and starts typing a draft", async () => {
      await user.type("composer", QUEUED, { verify: true });
      await user.press("Enter");
      await user.see({ text: "1 queued" });
      await user.see("composer", { editable: true, text: "" });
      await user.type("composer", DRAFT, { verify: true });
      await user.screenshot();
    });

    const before = await messages();
    const relaunched = await step(`the desktop is restarted (${mode})`, async () => world.restart(mode));
    user = user.on(relaunched);
    probe = probe.on(relaunched);
    agent = agent.on(relaunched);

    await step("the person reopens the thread", async () => {
      await reopenThread(world.prompts.interrupted);
      await user.screenshot();
    });

    if (keepsUnsent) await step("the queued follow-up and the draft come back as unsent text in the composer, and nothing was sent", async () => {
      await user.see("composer", { editable: true, text: new RegExp(`${QUEUED}[\\s\\S]*${DRAFT}`), timeoutMs: 30_000 });
      await user.notSee({ text: /\d+ queued/ });
      // Recalling an earlier prompt never overwrites unsent words.
      await user.click("composer");
      await user.press("ArrowUp");
      await user.see("composer", { text: new RegExp(DRAFT) });
      expect(await world.mock.agentRequests({ promptMarker: QUEUED })).toHaveLength(0);
      expect(userTexts(await messages()).some((text) => text.includes(QUEUED))).toBe(false);
      await user.screenshot();
      await user.type("composer", " ", { replace: true });
      await user.press("Backspace");
      await user.see("composer", { editable: true, text: "" });
    });

    await step("the person types the next message", async () => {
      await typeAndSend(relaunched, world.prompts.continuation);
    });

    await step("the typed message is accepted once and answered", async () => {
      const outcome = await probe.eventually(async () => {
        const composer = await probe.composer();
        const text = await probe.text();
        const history = await messages();
        return {
          draft: composer.draftText,
          replied: history.some((message) => message.role === "assistant"
            && message.parts.some((part) => part.type === "text" && part.text === world.prompts.continuationReply)),
          continuations: userTexts(history).filter((value) => value.trim() === world.prompts.continuation).length,
          recoveries: userTexts(history).filter((value) => value.includes(world.prompts.recoveryMarker)).length,
          bounced: composer.draftText.trim() === world.prompts.continuation,
          notice: /unsent message|could not|failed|unavailable|unknown|not accepted|timed out/i.test(text) ? text.slice(-1_200) : null,
          active: await active(),
        };
      }, {
        within: 120_000, label: "the continuation is answered or bounced back",
        until: (state) => state.replied || state.bounced,
      });
      await user.screenshot();
      const accepted = outcome.replied && !outcome.bounced && outcome.continuations === 1;
      evidence.recordAssertionEvidence(
        `After a ${mode}, the typed continuation was accepted once and answered without returning to the composer`,
        JSON.stringify({ ...outcome, notice: outcome.notice ? "shown" : null }),
        accepted,
      );
      expect(outcome, `continuation outcome after ${mode}: ${JSON.stringify(outcome)}`).toMatchObject({ replied: true, bounced: false, continuations: 1 });
      expect(outcome.draft).toBe("");
      // The interrupted turn's tool ran once, before the restart; nothing replays it.
      expect((await world.mock.agentRequests({ promptMarker: world.prompts.interrupted })).filter((call) => call.kind === "tool")).toHaveLength(1);
      expect((await world.mock.agentRequests({ promptMarker: world.prompts.continuation })).filter((call) => call.kind === "final")).toHaveLength(1);
      // Earlier history is intact.
      expect((await messages()).slice(0, before.length).map((message) => message.id)).toEqual(before.map((message) => message.id));
      await user.see({ text: world.prompts.continuationReply });
    });
  });
}
