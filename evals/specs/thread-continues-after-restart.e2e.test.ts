import { basename } from "node:path";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { assertWitnessModel, reloadRenderer, restartedThreadWorld, slowUncappedHistoryReads, type RestartMode } from "../worlds/thread-restart.ts";

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
const SLOW_HISTORY_READ_MS = 12_000;

const cases: { title: string; mode: RestartMode; slowHistory: boolean }[] = [
  { title: "a thread interrupted by a crash accepts the next typed message after relaunch", mode: "kill", slowHistory: false },
  { title: "a thread interrupted by a quit accepts the next typed message after relaunch", mode: "quit", slowHistory: false },
  { title: "a slow complete-history read after relaunch never bounces the typed message", mode: "quit", slowHistory: true },
];

for (const { title, mode, slowHistory } of cases) {
  test(title, async ({ world, user, probe, agent, step, evidence }) => {
    user = user.on(world.app);
    probe = probe.on(world.app);
    agent = agent.on(world.app);
    const v2 = world.engine === "v2";
    const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${v2 ? "opencode2/api" : "opencode"}`;
    const read = async (path: string): Promise<unknown> => {
      const response = await probe.desktopApi(`${mount}${path}`);
      expect(response.status).toBe(200);
      return v2 ? record(response.body).data : response.body;
    };
    const messages = async () => {
      const value = await read(`/session/${world.session.sessionId}/${v2 ? "context" : "message?limit=100"}`);
      if (!Array.isArray(value)) throw new Error("Expected engine messages");
      return value.map((entry: unknown) => {
        const message = record(entry);
        const info = v2 ? message : record(message.info);
        const parts = v2 ? message.content : message.parts;
        if (!Array.isArray(parts)) throw new Error("Expected message parts");
        return { id: String(info.id), role: String(info[v2 ? "type" : "role"]), parts: parts.map(record) };
      });
    };
    const userTexts = (items: Awaited<ReturnType<typeof messages>>) => items.filter((message) => message.role === "user")
      .map((message) => message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join(""));
    const active = async () => {
      const statuses = record(await read(v2 ? "/session/active" : "/session/status"));
      const status = statuses[world.session.sessionId];
      return status !== undefined && ["running", "busy", "retry"].includes(String(record(status).type));
    };
    const onThread = async () => (await probe.hash()).includes(`/session/${world.session.sessionId}`);
    const composerSettled = async () => {
      // The thread view rehydrates its draft shortly after opening; act only
      // once the composer is editable and has stopped changing.
      await probe.eventually(async () => {
        const first = await probe.composer();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
        const second = await probe.composer();
        return first.composerEditable && second.composerEditable && first.draftText === second.draftText && second.draftText === "";
      }, { within: 30_000, label: "the composer is ready", until: Boolean });
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

    const before = await messages();
    const relaunched = await step(`the desktop is restarted (${mode})`, async () => world.restart(mode));
    user = user.on(relaunched);
    probe = probe.on(relaunched);
    agent = agent.on(relaunched);

    const fault = slowHistory
      ? await step("the relaunched engine answers the thread's complete history slowly", async () => {
        const installed = await slowUncappedHistoryReads(relaunched, world.workspace.workspaceId, world.session.sessionId, SLOW_HISTORY_READ_MS);
        // The fault takes effect from the next document.
        await reloadRenderer(relaunched);
        return installed;
      })
      : null;

    try {
      await step("the person reopens the thread", async () => {
        await reopenThread(world.prompts.interrupted);
        await user.screenshot();
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
          `After a ${mode}${slowHistory ? " and a slow complete-history read" : ""}, the typed continuation was accepted once and answered without returning to the composer`,
          JSON.stringify({ ...outcome, notice: outcome.notice ? "shown" : null }),
          accepted,
        );
        expect(outcome, `continuation outcome after ${mode}${slowHistory ? " with slow history" : ""}: ${JSON.stringify(outcome)}`).toMatchObject({ replied: true, bounced: false, continuations: 1 });
        expect(outcome.draft).toBe("");
        if (fault) {
          // The slow uncapped read was really in the way, and the send did not
          // wait on it: a bounded read carried the current turn instead.
          const reads = await fault.read();
          expect(reads.delayed, `uncapped reads delayed: ${JSON.stringify(reads)}`).toBeGreaterThanOrEqual(1);
          expect(reads.bounded, `bounded reads passed: ${JSON.stringify(reads)}`).toBeGreaterThanOrEqual(1);
        }
        // The interrupted turn's tool ran once, before the restart; nothing replays it.
        expect((await world.mock.agentRequests({ promptMarker: world.prompts.interrupted })).filter((call) => call.kind === "tool")).toHaveLength(1);
        expect((await world.mock.agentRequests({ promptMarker: world.prompts.continuation })).filter((call) => call.kind === "final")).toHaveLength(1);
        // Earlier history is intact.
        expect((await messages()).slice(0, before.length).map((message) => message.id)).toEqual(before.map((message) => message.id));
        await user.see({ text: world.prompts.continuationReply });
      });
    } finally {
      await fault?.dispose();
    }
  });
}
