import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  longHistory,
  longHistoryCount,
  longHistoryFirst,
  longHistoryLast,
  longHistoryOtherTitle,
  longHistoryTitle,
  warmCachedLongHistory,
} from "../worlds/chat.ts";

const test = spec.world((seed) => longHistory(seed, { holdAncillaryReads: true }), { timeout: 600_000 });
const warmTest = spec.world(warmCachedLongHistory, { timeout: 600_000 });

/** The page size the transcript read used to request; OpenCode returns the newest n. */
const oldPageSize = 140;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageTexts(body: unknown): string[] {
  if (!Array.isArray(body)) throw new Error(`Engine did not return a message list: ${JSON.stringify(body).slice(0, 200)}`);
  return body.flatMap((message) => {
    if (!isRecord(message) || !Array.isArray(message.parts)) return [];
    return message.parts.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []));
  });
}

function renderedCount(value: unknown): number {
  if (!isRecord(value) || value.ok !== true || typeof value.messageCount !== "number") {
    throw new Error(`session.read_transcript did not report a rendered count: ${JSON.stringify(value)}`);
  }
  return value.messageCount;
}

function ancillaryReads(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Ancillary request identities are missing");
  return value.map((read) => {
    if (!isRecord(read) || typeof read.id !== "number" || typeof read.startedAt !== "number"
      || (read.kind !== "status" && read.kind !== "todo")
      || (read.openedAt !== null && typeof read.openedAt !== "number")
      || (read.settledAt !== null && typeof read.settledAt !== "number")
      || typeof read.sameTurnAbort !== "boolean") throw new Error(`Invalid ancillary request: ${JSON.stringify(read)}`);
    return {
      id: read.id, kind: read.kind, openedAt: read.openedAt, startedAt: read.startedAt,
      settledAt: read.settledAt, outcome: read.outcome, abortName: read.abortName, sameTurnAbort: read.sameTurnAbort,
    };
  });
}

function ancillaryFault(value: unknown) {
  if (!isRecord(value) || !isRecord(value.status) || !isRecord(value.todo) || !isRecord(value.history)
    || !isRecord(value.opening) || (value.opening.openedAt !== null && typeof value.opening.openedAt !== "number")) {
    throw new Error(`Long history ancillary fault did not publish its witness: ${JSON.stringify(value)}`);
  }
  return {
    workspaceId: value.workspaceId, sessionId: value.sessionId, documentId: value.documentId,
    released: value.released, expired: value.expired,
    status: value.status, todo: value.todo, history: value.history, reads: ancillaryReads(value.reads),
    opening: {
      openedAt: value.opening.openedAt, trusted: value.opening.trusted,
      first: value.opening.first, latest: value.opening.latest, full: value.opening.full,
    },
  };
}

function openingPaint(value: unknown, openedAt: number | null, deadlineMs: number) {
  if (!isRecord(value) || typeof value.at !== "number" || typeof value.elapsedMs !== "number" || openedAt === null) {
    throw new Error(`The trusted opening did not produce a frame witness: ${JSON.stringify(value)}`);
  }
  expect(value.elapsedMs, JSON.stringify(value)).toBeLessThan(deadlineMs);
  expect(value.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(value.at - openedAt).toBe(value.elapsedMs);
  expect(value).toMatchObject({ latestVisible: true, released: false, expired: false });
  const reads = ancillaryReads(value.reads).filter((read) => read.openedAt === openedAt);
  for (const read of reads) {
    expect(read.startedAt).toBeGreaterThanOrEqual(openedAt);
    expect(read.startedAt).toBeLessThanOrEqual(value.at);
    if (read.sameTurnAbort) {
      expect(read).toMatchObject({ outcome: "aborted", abortName: "AbortError" });
      if (read.settledAt === null) throw new Error("A mount cancellation has no settlement timestamp");
      expect(read.settledAt - read.startedAt).toBeLessThan(50);
    } else {
      expect(read, JSON.stringify(value)).toMatchObject({ outcome: "pending", settledAt: null });
    }
  }
  const originals = ["status", "todo"].map((kind) => {
    const original = reads.find((read) => read.kind === kind && !read.sameTurnAbort);
    if (!original) throw new Error(`No original post-click ${kind} read was pending at the frame: ${JSON.stringify(value)}`);
    return original;
  });
  return { ...value, at: value.at, elapsedMs: value.elapsedMs, originals };
}

test("opening a long conversation shows the latest and full history while ancillary reads remain pending", async ({ user, agent, probe, step, world, evidence }) => {
  const messagesPath = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode/session/${encodeURIComponent(world.session.sessionId)}/message`;
  const surface = `[data-session-surface-id="${world.session.sessionId}"]`;
  const sidebarTarget = { testId: `sidebar-session-${world.session.sessionId}` };
  const latestVisible = async () => {
    const { elements } = await probe.dom(`${surface} [data-thread-scroll], ${surface} [data-message-id]`);
    const viewport = elements[0];
    const latest = elements.slice(1).find((element) => element.text.includes(longHistoryLast));
    return Boolean(viewport && latest && latest.rect.height > 0 && latest.rect.bottom > viewport.rect.top && latest.rect.top < viewport.rect.bottom);
  };
  const readFault = () => probe.storage(world.ancillaryFaultKey, ancillaryFault);

  await step("the engine stores more messages than one newest-first page holds", async () => {
    const stored = await probe.desktopApi(messagesPath);
    expect(stored.status).toBe(200);
    const texts = messageTexts(stored.body);
    expect(texts).toHaveLength(longHistoryCount);
    expect(texts[0]).toBe(longHistoryFirst);
    expect(texts.at(-1)).toBe(longHistoryLast);

    // Witness for the trap: a `limit` page is the NEWEST n messages, so the
    // first message is outside it. The spec would be vacuous otherwise.
    const page = await probe.desktopApi(`${messagesPath}?limit=${oldPageSize}`);
    expect(page.status).toBe(200);
    const pageTexts = messageTexts(page.body);
    expect(pageTexts).toHaveLength(oldPageSize);
    expect(pageTexts).not.toContain(longHistoryFirst);
    expect(pageTexts.at(-1)).toBe(longHistoryLast);
    evidence.recordAssertionEvidence(
      "Stored history is read through the real native desktop",
      JSON.stringify({ kind: world.app.handle.kind, host: world.app.handle.hostKind, pid: world.app.handle.pid,
        profileDir: world.app.handle.profileDir, profileOwner: world.app.handle.meta?.profileOwner, workspaceRoot: world.app.workspaceRoot,
        storedMessages: texts.length, pageMessages: pageTexts.length }),
      true,
    );
  });

  await step("a cold start lands on the other session with no transcript cached for the long one", async () => {
    await user.reload();
    await user.see({ ...sidebarTarget, role: "button", label: new RegExp(`^${longHistoryTitle}`) }, { timeoutMs: 60_000 });
    await user.notSee({ text: longHistoryLast });
    await user.notSee({ text: longHistoryFirst });
    expect((await probe.dom(`[data-session-surface-id="${world.other.sessionId}"]`)).elements).toHaveLength(1);
    const fault = await readFault();
    expect(fault).toMatchObject({
      released: false, expired: false, opening: { openedAt: null, trusted: false, first: null, latest: null, full: null },
      todo: { attempts: 0 }, history: { limited: 0, full: 0, fullSucceeded: 0 },
    });
    expect(fault.reads.every((read) => read.openedAt === null)).toBe(true);
  });

  await step("clicking the long conversation renders latest and full history before ancillary reads settle", async () => {
    await user.click(sidebarTarget);
    await probe.eventually(readFault, {
      within: 2_000, label: "trusted click reaches the exact sidebar session",
      until: (fault) => fault.opening.trusted === true,
    });
    const visible = await probe.eventually(readFault, {
      within: 15_000, label: "first transcript frame and latest message after the trusted click",
      until: (fault) => isRecord(fault.opening.first) && isRecord(fault.opening.latest),
    });
    expect(visible.opening.trusted).toBe(true);
    const first = openingPaint(visible.opening.first, visible.opening.openedAt, 2_000);
    const latest = openingPaint(visible.opening.latest, visible.opening.openedAt, 2_000);
    const originalIds = first.originals.map((read) => read.id);
    expect(latest.originals.map((read) => read.id)).toEqual(originalIds);
    expect(await latestVisible()).toBe(true);
    const rendered = await probe.eventually(async () => renderedCount(await agent.run("session.read_transcript", { count: 1 })), {
      within: 60_000,
      label: "rendered transcript length",
      until: (count) => count >= longHistoryCount,
    });
    expect(rendered).toBe(longHistoryCount);
    expect(rendered).not.toBe(oldPageSize);
    await probe.eventually(async () => {
      expect(await latestVisible()).toBe(true);
      return (await probe.dom(`${surface} [data-thread-history-complete="true"]`)).elements.length;
    }, { within: 30_000, label: "background history mounting preserves the latest viewport", until: (count) => count === 1 });
    expect((await probe.dom(`${surface} [data-thread-loading]`)).elements).toHaveLength(0);
    expect((await probe.dom(`${surface} [data-message-id]`)).elements).toHaveLength(longHistoryCount);
    const fault = await probe.eventually(readFault, {
      within: 15_000, label: "full history frame recorded without replacing the original held reads",
      until: (value) => isRecord(value.opening.full),
    });
    expect(fault).toMatchObject({ workspaceId: world.workspace.workspaceId, sessionId: world.session.sessionId, released: false, expired: false });
    const full = openingPaint(fault.opening.full, fault.opening.openedAt, 5_000);
    expect(full).toMatchObject({ messageCount: longHistoryCount, historyComplete: true });
    expect(full.originals.map((read) => read.id)).toEqual(originalIds);
    for (const original of full.originals) {
      const current = fault.reads.find((read) => read.id === original.id);
      expect(current?.startedAt).toBe(original.startedAt);
      if (current?.settledAt !== null) expect(current?.settledAt).toBeGreaterThan(full.at);
    }
    expect(fault.history.full).toBeGreaterThan(0);
    expect(fault.history.fullSucceeded).toBeGreaterThan(0);
    expect((await probe.dom(`${surface} [data-testid="session-error-card"]`)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence(
      "The cold transcript appears before the original post-click ancillary reads settle, not after a timeout and retry",
      JSON.stringify({ documentId: fault.documentId, opening: fault.opening, reads: fault.reads, history: fault.history, originalIds }),
      true,
    );
  });

  await step("the first message is reachable at the top of the transcript", async () => {
    await agent.run("session.scroll_top");
    await user.see({ text: longHistoryFirst }, { timeoutMs: 30_000 });
    await probe.eventually(() => probe.dom(`${surface} [data-thread-history-status]`), {
      within: 10_000, label: "earlier-history status disappears at the first message", until: value => value.elements.length === 0,
    });
    const first = (await probe.dom(`${surface} [data-message-role="user"]`)).elements[0];
    expect(first?.text).toContain(longHistoryFirst);
    evidence.recordAssertionEvidence("The first stored user message renders without an earlier-history status", JSON.stringify({ first: first?.text, status: (await probe.dom(`${surface} [data-thread-history-status]`)).elements.length }), true);
    await user.looks([
      `The conversation transcript visibly starts with a user message reading "${longHistoryFirst}"`,
      "The transcript shows no loading indicator, error card, or empty-conversation placeholder",
    ]);
  });

  // Baseline branch coverage after full loading, not the delayed-preview race.
  await step("after full loading, branching at the first message excludes later history and leaves the source unchanged", async () => {
    await user.hover({ text: longHistoryFirst });
    await user.click({ role: "button", label: "Branch in new chat", nth: 0 });
    // count limits returned messages; messageCount is the entire rendered transcript.
    await probe.eventually(async () => renderedCount(await agent.run("session.read_transcript", { count: 1 })), {
      within: 30_000,
      label: "branch contains only the clicked message",
      until: (count) => count === 1,
    });
    await user.see({ text: longHistoryFirst });
    await user.notSee({ text: longHistoryLast });
    const source = await probe.desktopApi(messagesPath);
    expect(source.status).toBe(200);
    expect(messageTexts(source.body)).toHaveLength(longHistoryCount);
  });
});

warmTest("returning to a fully cached conversation refreshes its persisted tail before the uncapped read completes", async ({ user, agent, probe, step, world, evidence }) => {
  const messagesPath = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode/session/${encodeURIComponent(world.session.sessionId)}/message`;
  const surface = `[data-session-surface-id="${world.session.sessionId}"]`;
  const historyDom = async () => {
    const { elements } = await probe.dom(`${surface} [data-thread-scroll], ${surface} [data-message-id]`);
    return { viewport: elements[0], rows: elements.slice(1) };
  };
  const persisted = await step("the complete tail is persisted before reload, without submitting a prompt", async () => {
    const stored = await probe.desktopApi(messagesPath);
    expect(stored.status).toBe(200);
    const texts = messageTexts(stored.body);
    expect(texts).toHaveLength(longHistoryCount);
    expect(texts[0]).toBe(longHistoryFirst);
    expect(texts.at(-1)).toBe(longHistoryLast);
    const latest = await probe.desktopApi(`${messagesPath}?limit=24`);
    expect(latest.status).toBe(200);
    expect(messageTexts(latest.body)).toEqual(texts.slice(-24));
    await user.reload();
    await user.see({ role: "button", label: new RegExp(`^${longHistoryOtherTitle}`) }, { timeoutMs: 60_000 });
    expect((await probe.dom(surface)).elements).toHaveLength(0);
    return texts;
  });

  await using fault = await world.startHistoryFault();
  const cached = await step("an earlier uncapped response fills the full cache but omits the already persisted last message", async () => {
    await user.click({ role: "button", label: new RegExp(`^${longHistoryTitle}`) });
    const initial = await probe.eventually(() => fault.read(), {
      within: 60_000,
      label: "the earlier full snapshot is cached and idle",
      until: (value) => value.snapshot?.sessionId === world.session.sessionId && value.snapshot.count === longHistoryCount - 1
        && value.snapshot.status === "success" && value.snapshot.fetchStatus === "idle",
    });
    expect(initial.reads).toContainEqual({
      warm: false, limit: null, nativeCount: longHistoryCount, count: longHistoryCount - 1, hasTail: false, delivered: true,
    });
    expect(initial).toMatchObject({ armed: false, released: false, expired: false, held: 0, mutations: 0 });
    expect(renderedCount(await agent.run("session.read_transcript", { count: 1 }))).toBe(longHistoryCount - 1);
    await probe.eventually(() => probe.dom(`${surface} [data-thread-history-complete="true"]`), {
      within: 30_000, label: "all earlier history is mounted", until: (value) => value.elements.length === 1,
    });
    const { rows } = await historyDom();
    expect(rows).toHaveLength(longHistoryCount - 1);
    rows.forEach((row, index) => expect(row.text).toContain(persisted[index]));
    expect(rows.some((row) => row.text.includes(longHistoryLast))).toBe(false);
    expect((await probe.dom(`${surface} [data-lexical-editor="true"]`)).elements.map((element) => element.text)).toEqual([""]);

    await agent.run("session.scroll_top");
    let previous = Number.NaN;
    let stable = 0;
    const anchor = await probe.eventually(async () => {
      const { viewport, rows } = await historyDom();
      const first = rows[0];
      expect(first.text).toContain(longHistoryFirst);
      expect(first.rect.height).toBeGreaterThan(0);
      const offset = first.rect.top - viewport.rect.top;
      stable = offset >= 0 && offset < viewport.rect.height && Math.abs(offset - previous) <= 1 ? stable + 1 : 0;
      previous = offset;
      return { offset, stable };
    }, { within: 30_000, intervalMs: 100, label: "manual reading anchor settled at the first message", until: (value) => value.stable >= 3 });
    return { texts: rows.map((row) => row.text), offset: anchor.offset };
  });

  let maxAnchorDrift = 0;
  const observeReturn = async () => {
    const { viewport, rows } = await historyDom();
    const first = rows.find((row) => row.text.includes(longHistoryFirst));
    if (first && viewport && first.rect.height > 0) {
      maxAnchorDrift = Math.max(maxAnchorDrift, Math.abs(first.rect.top - viewport.rect.top - cached.offset));
    }
    return { viewport, rows };
  };
  const refreshed = await step("the warm newest-24 read adds the missing tail while the uncapped response stays held", async () => {
    await user.click({ role: "button", label: new RegExp(`^${longHistoryOtherTitle}`) });
    await probe.eventually(() => probe.dom(surface), {
      within: 30_000, label: "the long conversation is unmounted, not reloaded", until: (value) => value.elements.length === 0,
    });
    await fault.arm();
    await user.click({ role: "button", label: new RegExp(`^${longHistoryTitle}`) });
    const returned = await probe.eventually(async () => {
      const dom = await observeReturn();
      const state = await fault.read();
      return { ...dom, state };
    }, {
      within: 30_000,
      label: "persisted tail rendered before delivery of any warm uncapped response",
      until: ({ rows, state }) => rows.length === longHistoryCount && rows.some((row) => row.text.includes(longHistoryLast)) && state.held > 0,
    });
    expect(returned.state).toMatchObject({
      armed: true, released: false, expired: false, mutations: 0,
      snapshot: { sessionId: world.session.sessionId, count: longHistoryCount - 1, status: "success", fetchStatus: "fetching" },
    });
    expect(returned.state.reads).toContainEqual({ warm: true, limit: "24", nativeCount: 24, count: 24, hasTail: true, delivered: true });
    expect(returned.state.reads).toContainEqual({ warm: true, limit: null, nativeCount: longHistoryCount, count: longHistoryCount, hasTail: true, delivered: false });
    expect(returned.state.reads.filter((read) => read.warm && read.limit === null && read.delivered)).toHaveLength(0);
    expect(renderedCount(await agent.run("session.read_transcript", { count: 1 }))).toBe(longHistoryCount);
    expect(returned.rows.slice(0, -1).map((row) => row.text)).toEqual(cached.texts);
    expect(returned.rows.filter((row) => row.text.includes(longHistoryLast))).toHaveLength(1);
    expect(returned.rows.at(-1)?.text).toContain(longHistoryLast);
    expect(returned.rows[0].rect.top).toBeGreaterThanOrEqual(returned.viewport.rect.top);
    expect(returned.rows[0].rect.bottom).toBeLessThanOrEqual(returned.viewport.rect.bottom);
    expect(maxAnchorDrift).toBeLessThanOrEqual(1);
    expect((await fault.read()).held).toBeGreaterThan(0);
    return returned.rows.map((row) => row.text);
  });

  await step("releasing full history neither duplicates nor rolls back messages or the manual anchor", async () => {
    await fault.release();
    let historyChanged = false;
    const complete = await probe.eventually(async () => {
      const dom = await observeReturn();
      historyChanged ||= dom.rows.length !== refreshed.length || dom.rows.some((row, index) => row.text !== refreshed[index]);
      return { ...dom, state: await fault.read() };
    }, {
      within: 30_000,
      label: "the released full snapshot is applied without losing the fresh tail",
      until: ({ state }) => state.held === 0 && state.snapshot?.count === longHistoryCount && state.snapshot.fetchStatus === "idle",
    });
    expect(complete.state).toMatchObject({ released: true, expired: false, mutations: 0 });
    expect(complete.state.reads).toContainEqual({ warm: true, limit: null, nativeCount: longHistoryCount, count: longHistoryCount, hasTail: true, delivered: true });
    expect(historyChanged).toBe(false);
    expect(complete.rows.map((row) => row.text)).toEqual(refreshed);
    expect(renderedCount(await agent.run("session.read_transcript", { count: 1 }))).toBe(longHistoryCount);
    expect((await probe.dom(`${surface} [data-thread-history-complete="true"]`)).elements).toHaveLength(1);
    expect((await probe.dom(`${surface} [data-thread-loading]`)).elements).toHaveLength(0);
    const stored = await probe.desktopApi(messagesPath);
    expect(stored.status).toBe(200);
    expect(messageTexts(stored.body)).toEqual(persisted);
    expect((await observeReturn()).rows.map((row) => row.text)).toEqual(refreshed);
    expect(maxAnchorDrift).toBeLessThanOrEqual(1);
    evidence.recordAssertionEvidence(
      "Warm history retains the refreshed tail, unchanged source, and manual anchor after full-read release",
      JSON.stringify({ cachedMessages: cached.texts.length, refreshedMessages: refreshed.length, finalMessages: complete.rows.length,
        persistedMessages: messageTexts(stored.body).length, historyChanged, maxAnchorDrift, state: complete.state }),
      true,
    );
  });
});
