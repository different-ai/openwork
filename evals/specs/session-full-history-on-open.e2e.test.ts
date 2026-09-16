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

const pageSize = 24;
const scrollStorageKey = "openwork:session-scroll:v1";

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

function historyReads(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.pageReads)) throw new Error("History request witness is missing");
  const count = (value: unknown) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("Invalid history request count");
    return value;
  };
  const pageReads = value.pageReads.map((read) => {
    if (!isRecord(read) || (read.before !== null && typeof read.before !== "string")
      || (read.limit !== null && typeof read.limit !== "string")
      || (read.nextCursor !== null && typeof read.nextCursor !== "string")) throw new Error("Invalid history page read");
    return { before: read.before, limit: read.limit, nextCursor: read.nextCursor };
  });
  return { limited: count(value.limited), full: count(value.full), fullSucceeded: count(value.fullSucceeded), single: count(value.single), pageReads };
}

function savedPagePosition(value: unknown, workspaceId: string, sessionId: string, endpoint: string) {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(([key, state]) => {
    if (!isRecord(state) || typeof state.owner !== "string" || !state.owner || state.owner.length > 1024) return false;
    let owner: unknown;
    try { owner = JSON.parse(state.owner); } catch { return false; }
    return Array.isArray(owner) && owner.length === 4 && (owner[0] === null || typeof owner[0] === "string")
      && owner[1] === endpoint && owner[2] === workspaceId && owner[3] === sessionId
      && key === JSON.stringify(["session-scroll", state.owner, sessionId]);
  });
  if (entries.length > 1) throw new Error("Multiple scroll owners matched the native fixture");
  const state = entries[0]?.[1];
  if (!isRecord(state) || state.mode !== "manual" || typeof state.scrollTop !== "number" || !Number.isFinite(state.scrollTop)
    || state.scrollTop < 0 || !isRecord(state.anchor) || typeof state.anchor.messageId !== "string" || !state.anchor.messageId
    || state.anchor.messageId.length >= 256 || typeof state.anchor.offset !== "number" || !Number.isFinite(state.anchor.offset)
    || !isRecord(state.geometry) || state.geometry.owner !== state.owner) return null;
  const geometry = state.geometry;
  if (typeof geometry.scrollHeight !== "number" || !Number.isFinite(geometry.scrollHeight) || geometry.scrollHeight <= 0 || geometry.scrollHeight > 30_000_000
    || typeof geometry.viewportWidth !== "number" || !Number.isFinite(geometry.viewportWidth) || geometry.viewportWidth <= 0 || geometry.viewportWidth > 30_000
    || typeof geometry.before !== "number" || !Number.isFinite(geometry.before) || geometry.before < 0 || geometry.before > geometry.scrollHeight
    || typeof geometry.after !== "number" || !Number.isFinite(geometry.after) || geometry.after < 0 || geometry.after > geometry.scrollHeight
    || !Array.isArray(geometry.messageIds) || geometry.messageIds.length > 24
    || !geometry.messageIds.every((id): id is string => typeof id === "string" && id.length > 0 && id.length < 256)
    || new Set(geometry.messageIds).size !== geometry.messageIds.length || !geometry.messageIds.includes(state.anchor.messageId)
    || !isRecord(geometry.page)) return null;
  const page = geometry.page;
  const cursor = (value: unknown): value is string | null => value === null || typeof value === "string" && value.length > 0 && value.length <= 4096;
  if (typeof page.limit !== "number" || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100
    || !cursor(page.before) || !Array.isArray(page.lineage) || page.lineage.length === 0 || page.lineage.length > 64
    || !page.lineage.every(cursor) || page.lineage[0] !== null || page.lineage.at(-1) !== page.before
    || new Set(page.lineage).size !== page.lineage.length) return null;
  return {
    owner: state.owner, mode: state.mode, scrollTop: state.scrollTop,
    anchor: { messageId: state.anchor.messageId, offset: state.anchor.offset },
    geometry: { scrollHeight: geometry.scrollHeight, viewportWidth: geometry.viewportWidth, before: geometry.before,
      after: geometry.after, messageIds: geometry.messageIds, page: { before: page.before, limit: page.limit, lineage: page.lineage } },
  };
}

function ancillaryFault(value: unknown) {
  if (!isRecord(value) || !isRecord(value.status) || !isRecord(value.todo) || !isRecord(value.history)
    || !isRecord(value.opening) || (value.opening.openedAt !== null && typeof value.opening.openedAt !== "number")) {
    throw new Error(`Long history ancillary fault did not publish its witness: ${JSON.stringify(value)}`);
  }
  return {
    workspaceId: value.workspaceId, sessionId: value.sessionId, documentId: value.documentId,
    released: value.released, expired: value.expired,
    status: value.status, todo: value.todo, history: historyReads(value.history), reads: ancillaryReads(value.reads),
    opening: {
      openedAt: value.opening.openedAt, trusted: value.opening.trusted,
      first: value.opening.first, latest: value.opening.latest, full: value.opening.full,
    },
  };
}

function openingPaint(value: unknown, openedAt: number | null, deadlineMs: number) {
  if (!isRecord(value) || typeof value.at !== "number" || typeof value.elapsedMs !== "number"
    || typeof value.messageCount !== "number" || typeof value.historyComplete !== "boolean" || openedAt === null) {
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
  return { ...value, at: value.at, elapsedMs: value.elapsedMs, messageCount: value.messageCount, historyComplete: value.historyComplete, originals };
}

test("a long conversation pages on demand, restores its saved page cold and loads full history only for explicit top navigation", async ({ user, agent, probe, step, world, evidence }) => {
  const messagesPath = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode/session/${encodeURIComponent(world.session.sessionId)}/message`;
  const surface = `[data-session-surface-id="${world.session.sessionId}"]`;
  const sidebarTarget = { testId: `sidebar-session-${world.session.sessionId}` };
  const historyDom = async () => {
    const { elements } = await probe.dom(`${surface} [data-thread-scroll], ${surface} [data-message-id]`);
    const viewport = elements[0];
    if (!viewport) throw new Error("The long conversation has no transcript viewport");
    return { viewport, rows: elements.slice(1) };
  };
  const latestVisible = async () => {
    const { viewport, rows } = await historyDom();
    const latest = rows.find((element) => element.text.includes(longHistoryLast));
    return Boolean(latest && latest.rect.height > 0 && latest.rect.bottom > viewport.rect.top && latest.rect.top < viewport.rect.bottom);
  };
  const readingGeometry = async (messageId: string) => {
    const { elements } = await probe.dom(`${surface} [data-thread-scroll], ${surface} [data-message-id=${JSON.stringify(messageId)}]`);
    const [viewport, message] = elements;
    if (elements.length !== 2 || !viewport || !message) return null;
    return { text: message.text, offset: message.rect.top - viewport.rect.top,
      visible: message.rect.height > 0 && message.rect.bottom > viewport.rect.top && message.rect.top < viewport.rect.bottom };
  };
  const readFault = () => probe.storage(world.ancillaryFaultKey, ancillaryFault);
  const savedScroll = async () => {
    const port = await probe.storage("openwork.server.port");
    if ((typeof port !== "string" && typeof port !== "number") || !/^\d+$/.test(String(port))) throw new Error("Native server port is missing");
    const endpoint = `http://127.0.0.1:${port}/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode`;
    return probe.storage(scrollStorageKey, (value) => savedPagePosition(value, world.workspace.workspaceId, world.session.sessionId, endpoint));
  };
  const expectIdlePage = async (count: number) => {
    const transcript = await agent.run("session.read_transcript", { count: 1 });
    expect(renderedCount(transcript)).toBe(count);
    expect(transcript).toMatchObject({ historyComplete: false });
    await probe.eventually(() => probe.dom(`${surface} [data-message-id]`), {
      within: 5_000, label: "the bounded page finishes progressive mounting", until: (value) => value.elements.length === count,
    });
    expect((await probe.dom(`${surface} [data-thread-loading], ${surface} [data-thread-history-status], ${surface} [data-testid="session-error-card"]`)).elements).toHaveLength(0);
    expect((await readFault()).history).toMatchObject({ full: 0, fullSucceeded: 0, single: 0 });
  };

  const persisted = await step("the native engine stores 150 messages and its newest page holds only 24", async () => {
    const stored = await probe.desktopApi(messagesPath);
    expect(stored.status).toBe(200);
    const texts = messageTexts(stored.body);
    expect(texts).toHaveLength(longHistoryCount);
    expect(texts[0]).toBe(longHistoryFirst);
    expect(texts.at(-1)).toBe(longHistoryLast);
    const page = await probe.desktopApi(`${messagesPath}?limit=${pageSize}`);
    expect(page.status).toBe(200);
    const pageTexts = messageTexts(page.body);
    expect(pageTexts).toEqual(texts.slice(-pageSize));
    expect(pageTexts).not.toContain(longHistoryFirst);
    evidence.recordAssertionEvidence(
      "Stored history is read through the real native desktop",
      JSON.stringify({ kind: world.app.handle.kind, host: world.app.handle.hostKind, pid: world.app.handle.pid,
        profileDir: world.app.handle.profileDir, profileOwner: world.app.handle.meta?.profileOwner, workspaceRoot: world.app.workspaceRoot,
        storedMessages: texts.length, pageMessages: pageTexts.length }),
      true,
    );
    return texts;
  });

  await step("a cold start lands on the unrelated session without reading the long transcript", async () => {
    await user.reload();
    await user.see({ ...sidebarTarget, role: "button", label: new RegExp(`^${longHistoryTitle}`) }, { timeoutMs: 60_000 });
    await user.notSee({ text: longHistoryLast });
    await user.notSee({ text: longHistoryFirst });
    expect((await probe.dom(`[data-session-surface-id="${world.other.sessionId}"]`)).elements).toHaveLength(1);
    const fault = await readFault();
    expect(fault).toMatchObject({
      released: false, expired: false, opening: { openedAt: null, trusted: false, first: null, latest: null, full: null },
      todo: { attempts: 0 }, history: { limited: 0, full: 0, fullSucceeded: 0, single: 0, pageReads: [] },
    });
    expect(fault.reads.every((read) => read.openedAt === null)).toBe(true);
  });

  const initialPage = await step("the first paint shows the latest 24 within two seconds while ancillary reads remain pending", async () => {
    await user.click(sidebarTarget);
    await probe.eventually(readFault, {
      within: 2_000, label: "trusted click reaches the exact sidebar session",
      until: (fault) => fault.opening.trusted === true,
    });
    const visible = await probe.eventually(readFault, {
      within: 15_000, label: "first transcript frame and latest message after the trusted click",
      until: (fault) => isRecord(fault.opening.first) && isRecord(fault.opening.latest),
    });
    const first = openingPaint(visible.opening.first, visible.opening.openedAt, 2_000);
    const latest = openingPaint(visible.opening.latest, visible.opening.openedAt, 2_000);
    for (const frame of [first, latest]) {
      expect(frame.historyComplete).toBe(false);
      expect(frame.messageCount).toBeGreaterThan(0);
      expect(frame.messageCount).toBeLessThanOrEqual(pageSize);
    }
    const originalIds = first.originals.map((read) => read.id);
    expect(latest.originals.map((read) => read.id)).toEqual(originalIds);
    expect(await latestVisible()).toBe(true);
    await expectIdlePage(pageSize);
    const { rows } = await historyDom();
    rows.forEach((row, index) => expect(row.text).toContain(persisted[longHistoryCount - pageSize + index]));
    expect(rows.some((row) => row.text.includes(longHistoryFirst))).toBe(false);
    const fault = await readFault();
    expect(fault).toMatchObject({ workspaceId: world.workspace.workspaceId, sessionId: world.session.sessionId,
      released: false, expired: false, opening: { full: null } });
    expect(fault.history.limited).toBeGreaterThan(0);
    for (const read of fault.history.pageReads) expect(read).toMatchObject({ before: null, limit: String(pageSize) });
    const page = fault.history.pageReads.find((read) => read.nextCursor !== null);
    if (!page?.nextCursor) throw new Error("Native newest page did not expose its next cursor");
    evidence.recordAssertionEvidence(
      "The bounded cold transcript appears before the original ancillary reads settle, without an automatic full read",
      JSON.stringify({ documentId: fault.documentId, opening: fault.opening, reads: fault.reads, history: fault.history, originalIds }),
      true,
    );
    return page;
  });

  const olderPage = await step("PageUp at the loaded top prepends one native cursor page without moving the reading anchor", async () => {
    await user.click({ text: persisted[longHistoryCount - pageSize] });
    await user.press("Tab");
    expect((await probe.dom(`${surface} [data-thread-scroll] button:focus`)).elements).toHaveLength(1);
    const atTop = await probe.eventually(async () => {
      const saved = await savedScroll();
      if (!saved || saved.scrollTop !== 0 || saved.geometry.page.before !== null) return null;
      const geometry = await readingGeometry(saved.anchor.messageId);
      return geometry?.visible && geometry.text.includes(persisted[longHistoryCount - pageSize])
        && Math.abs(geometry.offset - saved.anchor.offset) <= 1 ? { saved, geometry } : null;
    }, { within: 5_000, label: "native reading anchor settled at the loaded page start", until: (value) => value !== null });
    if (!atTop) throw new Error("The newest page start was not reached");
    await expectIdlePage(pageSize);
    expect((await readFault()).history.pageReads.every((read) => read.before === null)).toBe(true);
    await user.press("PageUp");
    const prepended = await probe.eventually(async () => {
      const dom = await historyDom();
      const geometry = await readingGeometry(atTop.saved.anchor.messageId);
      return { ...dom, geometry, fault: await readFault() };
    }, { within: 10_000, label: "older page mounted at the unchanged native reading anchor",
      until: ({ rows, geometry }) => rows.length === pageSize * 2 && Boolean(geometry?.visible && Math.abs(geometry.offset - atTop.geometry.offset) <= 2) });
    prepended.rows.forEach((row, index) => expect(row.text).toContain(persisted[longHistoryCount - pageSize * 2 + index]));
    expect(new Set(prepended.rows.map((row) => row.text)).size).toBe(pageSize * 2);
    expect(prepended.geometry?.text).toBe(atTop.geometry.text);
    const older = prepended.fault.history.pageReads.filter((read) => read.before !== null);
    expect(older).toHaveLength(1);
    expect(older[0]).toMatchObject({ before: initialPage.nextCursor, limit: String(pageSize) });
    expect(older[0].nextCursor).toBeTruthy();
    expect(older[0].nextCursor).not.toBe(initialPage.nextCursor);
    await expectIdlePage(pageSize * 2);
    return older[0];
  });

  const readingPosition = await step("ordinary PageUp saves the first visible message inside the older page, not the newest page", async () => {
    await user.press("PageUp");
    let previousOffset = Number.NaN;
    let previousId = "";
    let stable = 0;
    const position = await probe.eventually(async () => {
      const saved = await savedScroll();
      if (!saved || saved.geometry.page.before !== olderPage.before) return null;
      const geometry = await readingGeometry(saved.anchor.messageId);
      const { viewport, rows } = await historyDom();
      const firstVisible = rows.find((row) => row.rect.height > 0 && row.rect.bottom > viewport.rect.top && row.rect.top < viewport.rect.bottom);
      if (!geometry?.visible || firstVisible?.text !== geometry.text
        || !persisted.slice(-pageSize * 2, -pageSize).some((text) => geometry.text.includes(text))
        || Math.abs(geometry.offset - saved.anchor.offset) > 2) return null;
      stable = previousId === saved.anchor.messageId && Math.abs(geometry.offset - previousOffset) <= 1 ? stable + 1 : 0;
      previousId = saved.anchor.messageId;
      previousOffset = geometry.offset;
      return { saved, geometry, stable };
    }, { within: 10_000, intervalMs: 100, label: "persisted older-page identity and visible offset settle", until: (value) => value !== null && value.stable >= 3 });
    if (!position) throw new Error("No older-page reading position was saved");
    expect(position.saved.geometry.page).toEqual({ before: initialPage.nextCursor, limit: pageSize, lineage: [null, initialPage.nextCursor] });
    expect(position.saved.geometry.messageIds).toHaveLength(pageSize);
    expect(await latestVisible()).toBe(false);
    await expectIdlePage(pageSize * 2);
    return position;
  });

  await step("after navigating away and reloading cold, the first read reuses the saved opaque page and restores its exact message offset", async () => {
    const previousDocument = (await readFault()).documentId;
    await user.click({ testId: `sidebar-session-${world.other.sessionId}` });
    await probe.eventually(() => probe.dom(surface), {
      within: 5_000, label: "the unrelated conversation replaces the target surface", until: (value) => value.elements.length === 0,
    });
    expect(await savedScroll()).toEqual(readingPosition.saved);
    expect((await readFault()).history).toMatchObject({ full: 0, fullSucceeded: 0, single: 0 });
    await user.reload();
    await user.see({ ...sidebarTarget, role: "button", label: new RegExp(`^${longHistoryTitle}`) }, { timeoutMs: 60_000 });
    expect((await probe.dom(`[data-session-surface-id="${world.other.sessionId}"]`)).elements).toHaveLength(1);
    expect((await probe.dom(surface)).elements).toHaveLength(0);
    const cold = await readFault();
    expect(cold.documentId).not.toBe(previousDocument);
    expect(cold.history).toEqual({ limited: 0, full: 0, fullSucceeded: 0, single: 0, pageReads: [] });
    expect(await savedScroll()).toEqual(readingPosition.saved);
    await user.click(sidebarTarget);
    let stable = 0;
    const restored = await probe.eventually(async () => {
      const geometry = await readingGeometry(readingPosition.saved.anchor.messageId);
      const dom = await historyDom();
      const firstVisible = dom.rows.find((row) => row.rect.height > 0 && row.rect.bottom > dom.viewport.rect.top && row.rect.top < dom.viewport.rect.bottom);
      const matches = geometry?.visible && geometry.text === readingPosition.geometry.text && firstVisible?.text === geometry.text
        && Math.abs(geometry.offset - readingPosition.geometry.offset) <= 2;
      stable = matches ? stable + 1 : 0;
      return { ...dom, geometry, stable, fault: await readFault() };
    }, { within: 15_000, intervalMs: 100, label: "cold saved-page restoration without revealing or scrolling the anchor",
      until: (value) => value.stable >= 3 && value.rows.length === pageSize });
    const savedPage = readingPosition.saved.geometry.page;
    expect(restored.fault.opening.trusted).toBe(true);
    expect(restored.fault.history.pageReads.length).toBeGreaterThan(0);
    expect(restored.fault.history.pageReads[0]).toEqual({ before: savedPage.before, limit: String(savedPage.limit), nextCursor: olderPage.nextCursor });
    for (const read of restored.fault.history.pageReads) expect(read).toMatchObject({ before: savedPage.before, limit: String(savedPage.limit) });
    restored.rows.forEach((row, index) => expect(row.text).toContain(persisted[longHistoryCount - pageSize * 2 + index]));
    expect(restored.rows.some((row) => row.text.includes(longHistoryFirst) || row.text.includes(longHistoryLast))).toBe(false);
    await expectIdlePage(pageSize);
    expect(await agent.run("session.read_transcript", { count: 1 })).toMatchObject({ includesNewest: false });
    const saved = await savedScroll();
    expect(saved?.anchor.messageId).toBe(readingPosition.saved.anchor.messageId);
    expect(saved?.geometry.page).toEqual(savedPage);
    evidence.recordAssertionEvidence(
      "Cold reopening starts with the exact saved page, makes no single-message or uncapped read, and restores the same message and offset",
      JSON.stringify({ page: savedPage, anchor: readingPosition.saved.anchor, restoredOffset: restored.geometry?.offset, history: restored.fault.history }),
      true,
    );
  });

  await step("explicit agent top navigation waits for all 150 messages and scrolls to the earliest one", async () => {
    expect((await readFault()).history.full).toBe(0);
    expect(await agent.run("session.scroll_top")).toMatchObject({ ok: true, position: "top" });
    const complete = await probe.eventually(async () => {
      const dom = await historyDom();
      const markers = await probe.dom(`${surface} [data-thread-history-complete="true"]`);
      return { ...dom, complete: markers.elements.length === 1, fault: await readFault() };
    }, { within: 30_000, label: "explicit full-history demand has mounted every message at the top",
      until: ({ rows, complete, viewport, fault }) => complete && rows.length === longHistoryCount && fault.history.fullSucceeded > 0
        && rows[0].rect.top >= viewport.rect.top && rows[0].rect.bottom <= viewport.rect.bottom });
    expect(complete.fault.history.full).toBeGreaterThan(0);
    expect(complete.fault.history.single).toBe(0);
    expect(renderedCount(await agent.run("session.read_transcript", { count: 1 }))).toBe(longHistoryCount);
    complete.rows.forEach((row, index) => expect(row.text).toContain(persisted[index]));
    expect(complete.rows[0].text).toContain(longHistoryFirst);
    expect((await probe.dom(`${surface} [data-thread-loading], ${surface} [data-thread-history-status], ${surface} [data-testid="session-error-card"]`)).elements).toHaveLength(0);
    await user.looks([
      `The conversation transcript visibly starts with a user message reading "${longHistoryFirst}"`,
      "The transcript shows no loading indicator, error card, or empty-conversation placeholder",
    ]);
  });

  await step("after full loading, branching at the first message excludes later history and leaves the source unchanged", async () => {
    await user.click({ role: "button", label: "Branch in new chat", nth: 0 });
    await probe.eventually(async () => renderedCount(await agent.run("session.read_transcript", { count: 1 })), {
      within: 30_000,
      label: "branch contains only the clicked message",
      until: (count) => count === 1,
    });
    await user.see({ text: longHistoryFirst });
    await user.notSee({ text: longHistoryLast });
    const source = await probe.desktopApi(messagesPath);
    expect(source.status).toBe(200);
    expect(messageTexts(source.body)).toEqual(persisted);
  });
});

warmTest("returning to a fully cached conversation refreshes its persisted tail before the uncapped read completes", async ({ user, agent, probe, step, world }) => {
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
  const cached = await step("explicit top navigation fills the full cache with an earlier snapshot omitting the persisted last message", async () => {
    await user.click({ role: "button", label: new RegExp(`^${longHistoryTitle}`) });
    await probe.eventually(() => probe.dom(`${surface} [data-message-id]`), {
      within: 30_000, label: "the bounded opening with its omitted tail is mounted before top navigation",
      until: (value) => value.elements.length === pageSize - 1,
    });
    expect(await agent.run("session.scroll_top")).toMatchObject({ ok: true, position: "top" });
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
    expect((await probe.dom(`${surface} [data-thread-history-status]`)).elements).toHaveLength(0);
    const stored = await probe.desktopApi(messagesPath);
    expect(stored.status).toBe(200);
    expect(messageTexts(stored.body)).toEqual(persisted);
    expect((await observeReturn()).rows.map((row) => row.text)).toEqual(refreshed);
    expect(maxAnchorDrift).toBeLessThanOrEqual(1);
  });
});
