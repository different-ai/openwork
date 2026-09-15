import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect } from "vitest";
import { evalIn } from "@openwork/behaviors";
import { attachSurface, browserScript, clickAt, connect, debuggerUrlFor, evaluate, listTargets, type Surface } from "@openwork/cdp";
import { eventually, readDenClientState, test } from "@openwork/testkit";

const releaseSha = "a0d6bd1de8debf4f09d22b8538e124b2ff45b339";
const widgetIds = ["today", "attention", "goals"];
const title = "Per-user dashboard on OpenWork v0.18.46 — two members, two identities, same tile";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Incomplete: invalid private owner receipt");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Incomplete: missing private owner receipt field");
  return value.trim();
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Incomplete: set ${key}`);
  return value;
}

function endpoint(key: string, local = false): string {
  const url = new URL(requiredEnv(key));
  if (url.username || url.password || url.search || url.hash
    || (local ? url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) : url.protocol !== "https:")) {
    throw new Error(`Incomplete: invalid ${key}`);
  }
  return url.href.replace(/\/$/, "");
}

async function homeFrame(surface: Surface): Promise<Surface & AsyncDisposable> {
  const matches: (Surface & AsyncDisposable)[] = [];
  try {
    const targets = (await listTargets(surface.handle.cdpUrl))
      .filter(target => target.type === "iframe" && (target.url === "about:srcdoc" || target.url.includes("/mcp-apps/sandbox.html")));
    for (const target of targets) {
      const raw = await connect(debuggerUrlFor(surface.handle.cdpUrl, target));
      let retained = false;
      try {
        const tree = object(await raw.send("Page.getFrameTree"));
        const frames: string[] = [];
        const visit = (value: unknown) => {
          const node = object(value);
          const frame = object(node.frame);
          if (frame.url === "about:srcdoc") frames.push(text(frame.id));
          if (Array.isArray(node.childFrames)) node.childFrames.forEach(visit);
        };
        visit(tree.frameTree);
        for (const frameId of frames) {
          const context = object(await raw.send("Page.createIsolatedWorld", { frameId, worldName: "peruser-home-observer" }));
          const contextId = context.executionContextId;
          if (typeof contextId !== "number") throw new Error("Missing App execution context");
          const client = { ...raw, send: (method: string, params: Record<string, unknown> = {}, options?: { timeoutMs?: number }) => raw.send(method,
            method === "Runtime.evaluate" ? { ...params, contextId }
              : method === "Runtime.callFunctionOn" ? { ...params, executionContextId: contextId } : params, options) };
          if (await evaluate(client, () => document.title === "Acme Home" && Boolean(document.querySelector(".shell")))) {
            retained = true;
            matches.push({ handle: surface.handle, client, [Symbol.asyncDispose]: async () => raw.close() });
          }
        }
      } finally { if (!retained) raw.close(); }
    }
    if (matches.length !== 1) throw new Error("Incomplete: exactly one real Acme Home frame must be mounted per desktop");
    const match = matches[0];
    if (!match) throw new Error("Incomplete: real Acme Home frame unavailable");
    return match;
  } catch (error) {
    await Promise.all(matches.map(match => match[Symbol.asyncDispose]()));
    throw error;
  }
}

async function view(surface: Surface) {
  await using frame = await homeFrame(surface);
  return evaluate(frame.client, browserScript(ids => {
    const visible = (element: Element | null) => Boolean(element && element.getClientRects().length
      && getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none");
    const heading = document.querySelector("h1");
    const greeting = visible(heading) ? heading?.textContent?.trim() ?? "" : "";
    return {
      name: document.querySelector('[data-testid="today-identity"]')?.textContent?.match(/^Signed in as (.+) · sub /)?.[1] ?? "",
      greeting,
      locked: document.body.innerText.includes("Connect to personalize"),
      widgets: ids.map(id => {
        const widget = document.querySelector(`.widget-${id}`);
        const titles = [...widget?.querySelectorAll(".detail summary") ?? []]
          .filter(visible).map(node => node.textContent?.replace("›", "").trim() ?? "").sort();
        const content = [...widget?.querySelectorAll('[data-testid="meeting-item"], [data-testid="attention-item"], [data-testid="goal-item"]') ?? []]
          .filter(visible).map(node => node.textContent?.trim() ?? "");
        return { id, visible: visible(widget), titles, content,
          generation: Number(widget?.querySelector(".receipt strong")?.textContent),
          instance: widget?.querySelector(".receipt span[title]")?.getAttribute("title") ?? "",
          polling: Boolean(widget?.querySelector<HTMLInputElement>('.polling input[type="checkbox"]')?.checked),
          error: Boolean(widget?.querySelector('[role="alert"]')) };
      }),
    };
  }, [widgetIds]));
}

type HomeView = Awaited<ReturnType<typeof view>>;

function ready(value: HomeView) {
  return !value.locked && Boolean(value.name) && value.widgets.length === 3 && value.widgets.every(widget =>
    widget.visible && widget.titles.length > 0 && widget.titles.every(Boolean)
    && Number.isInteger(widget.generation) && widget.generation > 0 && Boolean(widget.instance) && !widget.error && !widget.polling);
}

async function tile(surface: Surface, dashboardId: string, entryId: string) {
  return evalIn(surface, browserScript((dashboardId, entryId) => {
    const boards = [...document.querySelectorAll("[data-granted-dashboard]")]
      .filter(node => node.getAttribute("data-granted-dashboard") === dashboardId);
    const tiles = [...boards[0]?.querySelectorAll("[data-dashboard-entry]") ?? []]
      .filter(node => node.getAttribute("data-dashboard-entry") === entryId);
    return { desktop: Boolean(window.__OPENWORK_ELECTRON__), boards: boards.length, tiles: tiles.length,
      homeTiles: [...document.querySelectorAll('button[aria-label="Refresh Acme Home"]')].length };
  }, [dashboardId, entryId]));
}

async function refresh(surface: Surface, dashboardId: string, entryId: string) {
  const point = await evalIn(surface, browserScript((dashboardId, entryId) => {
    const board = [...document.querySelectorAll("[data-granted-dashboard]")]
      .find(node => node.getAttribute("data-granted-dashboard") === dashboardId);
    const tile = [...board?.querySelectorAll("[data-dashboard-entry]") ?? []]
      .find(node => node.getAttribute("data-dashboard-entry") === entryId);
    const button = tile?.querySelector<HTMLButtonElement>('button[aria-label="Refresh Acme Home"]');
    if (!button || button.disabled) return null;
    button.scrollIntoView({ block: "center" });
    const box = button.getBoundingClientRect();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    return box.width > 0 && box.height > 0 && hit && button.contains(hit) ? point : null;
  }, [dashboardId, entryId]));
  if (!point) throw new Error("Incomplete: released tile Refresh is not available");
  await clickAt(surface, point);
}

test("per-user Home: real hosted member names, isolated three-widget sets, and fresh generations", { timeout: 1_200_000 }, async ({ place, evidence }) => {
  const claims: { claim: string; status: "Passed" | "Failed" | "Incomplete"; detail: string }[] = [];
  const observations: Record<string, unknown> = {};
  const record = () => evidence.recordJsonArtifact("per-user-home-receipt", {
    version: 1, title, runId: basename(evidence.dir), runnerReceiptPath: join(evidence.dir, "test-run.json"),
    spec: "evals/specs/per-user-home-demo.e2e.test.ts", releaseSha,
    provenance: "Owner-supplied runtime and hosted identity receipts; not independently verified build or OAuth setup",
    video: { status: "PARTIAL", reason: "No capture performed by this spec; owner media must bind to this run" },
    claims, observations,
  });
  const claim = async <T>(name: string, failure: string, action: () => Promise<T>): Promise<T | undefined> => {
    try {
      const value = await action();
      claims.push({ claim: name, status: "Passed", detail: "Observable assertions completed" });
      evidence.recordAssertionEvidence(name, "Observable assertions completed; personal values withheld", true);
      return value;
    } catch (error) {
      const incomplete = error instanceof Error && error.message.startsWith("Incomplete:");
      const detail = incomplete ? error.message : failure;
      claims.push({ claim: name, status: incomplete ? "Incomplete" : "Failed", detail });
      evidence.recordAssertionEvidence(name, detail, false);
      return undefined;
    } finally { record(); }
  };

  await claim("Unauthenticated provider widget call is HTTP 401", "Provider did not return HTTP 401; no redirect or host 409 substitutes for it", async () => {
    expect(process.env.OPENWORK_EVAL_E2E_TESTS === "1", "Explicit E2E opt-in").toBe(true);
    const response = await fetch(endpoint("PERUSER_MCP_URL"), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "acme_home", arguments: { widget: "today" } } }),
    });
    observations.unauthenticatedProviderStatus = response.status;
    await response.body?.cancel();
    expect(response.status).toBe(401);
  });

  await claim("Real desktop journey", "Desktop journey assertions failed; see independent phase receipts", async () => {
    if (process.env.OPENWORK_EVAL_E2E_TESTS !== "1" || place.kind !== "local") throw new Error("Incomplete: explicit local reuse lane required");
    let privateReceipt: Record<string, unknown>;
    try {
      privateReceipt = object(JSON.parse(await readFile(requiredEnv("PERUSER_MEMBERS_RECEIPT"), "utf8")));
    } catch { throw new Error("Incomplete: PERUSER_MEMBERS_RECEIPT must point to the owner's private hosted identity/setup receipt"); }
    const upstreamAuthUrl = endpoint("PERUSER_UPSTREAM_AUTH_URL");
    const upstream = new URL(upstreamAuthUrl);
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(upstream.hostname)) throw new Error("Incomplete: upstream identity must be hosted, not the local world");
    const connection = object(privateReceipt.connection);
    const dashboard = object(privateReceipt.dashboard);
    const members = object(privateReceipt.members);
    const member = (alias: string) => {
      const value = object(members[alias]);
      if (value.hostedSessionVerified !== true) throw new Error(`Incomplete: member ${alias} must sign into hosted Den manually`);
      return { alias, name: text(value.name), sub: text(value.sub), orgId: text(value.orgId), hostMemberId: text(value.hostMemberId) };
    };
    const a = member("A");
    const b = member("B");
    const cdpA = endpoint("PERUSER_A_CDP_URL", true);
    const cdpB = endpoint("PERUSER_B_CDP_URL", true);
    expect(new URL(cdpA).port !== new URL(cdpB).port, "Separate owned desktop endpoints").toBe(true);
    expect(a.name !== b.name && a.sub !== b.sub && a.hostMemberId !== b.hostMemberId, "Two different members, not synthetic-name aliases").toBe(true);
    expect(a.orgId === b.orgId, "Same hosted organization, different subjects").toBe(true);
    expect(privateReceipt.identityMode === "openwork" && privateReceipt.upstreamAuthUrl === upstreamAuthUrl).toBe(true);
    expect(privateReceipt.desktopSourceSha === releaseSha && privateReceipt.desktopVersion === "0.18.46", "Owner release receipt").toBe(true);
    expect(connection.url === endpoint("PERUSER_MCP_URL") && connection.authType === "oauth"
      && connection.credentialMode === "per_member" && connection.issuer === new URL(endpoint("PERUSER_MCP_URL")).origin
      && connection.dcr === true && JSON.stringify(connection.scopes) === '["home:read"]', "Owner connection setup receipt").toBe(true);
    expect(dashboard.toolName === "acme_home" && dashboard.resourceUri === "ui://acme-home/home.html"
      && JSON.stringify(dashboard.launchArguments) === "{}" && dashboard.orgWide === false, "One default launch reference, no identity arguments").toBe(true);
    expect(Array.isArray(dashboard.namedMemberIds) && dashboard.namedMemberIds.length === 2
      && dashboard.namedMemberIds.includes(a.hostMemberId) && dashboard.namedMemberIds.includes(b.hostMemberId), "Owner named-sharing receipt").toBe(true);
    const dashboardId = text(dashboard.id);
    const entryId = text(dashboard.entryId);
    const hostOrgId = text(dashboard.hostOrgId);
    const waitMs = Number(process.env.PERUSER_CONSENT_WAIT_MS ?? "300000");
    if (!Number.isInteger(waitMs) || waitMs < 1000 || waitMs > 300000) throw new Error("Incomplete: consent wait must be 1000–300000 ms");
    await using desktopA = await attachSurface({ name: "peruser-A", kind: "electron", hostKind: "local", cdpUrl: cdpA });
    await using desktopB = await attachSurface({ name: "peruser-B", kind: "electron", hostKind: "local", cdpUrl: cdpB });
    const actors = [{ surface: desktopA, member: a }, { surface: desktopB, member: b }];
    const phaseStart = claims.length;
    for (const { surface, member } of actors) {
      await claim(`${member.alias}: before-connect view`, "Connect to personalize was absent or contained personal/sample data; host consent gating may precede the provider shell", async () => {
        const state = await readDenClientState(surface);
        expect(state.authTokenPresent && state.activeOrgId === hostOrgId, "Owned desktop signed into intended host organization").toBe(true);
        expect(await tile(surface, dashboardId, entryId)).toEqual({ desktop: true, boards: 1, tiles: 1, homeTiles: 1 });
        const initial = await view(surface);
        observations[`before${member.alias}`] = { connectToPersonalize: initial.locked, personalNameAbsent: !initial.name,
          widgetCounts: initial.widgets.map(widget => widget.titles.length) };
        expect(initial.locked && !initial.name && initial.widgets.every(widget => widget.titles.length === 0)).toBe(true);
      });
    }
    console.log("[PERUSER] Before-connect observations recorded. Owner may now complete each hosted consent independently and open/refresh the shared tile. No OAuth is automated.");
    const views = new Map<string, HomeView>();
    for (const { surface, member } of actors) {
      const rendered = await claim(`${member.alias}: connected real name and three sets`, "Hosted consent or connected Home rendering did not complete with the expected real name and all three sets", async () => {
        const value = await eventually(() => view(surface), { within: waitMs, intervalMs: 1500,
          until: result => ready(result) && result.name === member.name, label: `member ${member.alias} manually connected Home` });
        expect(await tile(surface, dashboardId, entryId)).toEqual({ desktop: true, boards: 1, tiles: 1, homeTiles: 1 });
        expect(ready(value) && value.name === member.name).toBe(true);
        observations[`connected${member.alias}`] = { expectedNameMatches: true, generations: value.widgets.map(widget => widget.generation),
          widgetCounts: value.widgets.map(widget => widget.titles.length) };
        return value;
      });
      if (rendered) views.set(member.alias, rendered);
    }
    await claim("A/B: same tile, different real names and all three content sets", "At least one pair of personal names or widget content sets matched", async () => {
      const left = views.get("A");
      const right = views.get("B");
      if (!left || !right) throw new Error("Incomplete: both connected member views are required for isolation comparison");
      const differentSets = widgetIds.map((id, index) => left.widgets[index]?.id === id && right.widgets[index]?.id === id
        && JSON.stringify(left.widgets[index]?.titles) !== JSON.stringify(right.widgets[index]?.titles));
      observations.isolation = { differentNames: left.name !== right.name, differentSets };
      expect(left.name !== right.name && differentSets.every(Boolean)).toBe(true);
    });
    for (const { surface, member } of actors) {
      await claim(`${member.alias}: one tile Refresh increments all generations and preserves identity/content`, "Refresh failed, reset an instance counter, or changed personal identity/content; no retry performed", async () => {
        const before = views.get(member.alias);
        if (!before) throw new Error(`Incomplete: member ${member.alias} connected baseline unavailable`);
        await refresh(surface, dashboardId, entryId);
        const after = await eventually(() => view(surface), { within: 45000, intervalMs: 1000,
          until: result => ready(result) && result.widgets.every((widget, index) => widget.generation !== before.widgets[index]?.generation
            || widget.instance !== before.widgets[index]?.instance), label: `member ${member.alias} fresh tool generation` });
        const increments = after.widgets.map((widget, index) => widget.generation > before.widgets[index].generation);
        const sameInstances = after.widgets.map((widget, index) => widget.instance === before.widgets[index].instance);
        const rotated = after.widgets.map((widget, index) => JSON.stringify(widget.content) !== JSON.stringify(before.widgets[index].content));
        observations[`refresh${member.alias}`] = { expectedNameMatches: after.name === member.name, increments, sameInstances, rotated,
          before: before.widgets.map(widget => widget.generation), after: after.widgets.map(widget => widget.generation) };
        expect(after.name === member.name && rotated.some(Boolean) && sameInstances.every(Boolean) && increments.every(Boolean)).toBe(true);
        views.set(member.alias, after);
        const other = actors.find(actor => actor.member.alias !== member.alias);
        const otherBefore = other && views.get(other.member.alias);
        if (!other || !otherBefore) throw new Error("Incomplete: other member baseline required for refresh isolation");
        const otherAfter = await view(other.surface);
        const otherUnchanged = ready(otherAfter) && otherAfter.name === otherBefore.name
          && JSON.stringify(otherAfter.widgets) === JSON.stringify(otherBefore.widgets);
        observations[`refresh${member.alias}OtherUnchanged`] = otherUnchanged;
        expect(otherUnchanged, "Refreshing one member must not change the other member's view").toBe(true);
      });
    }
    expect(claims.slice(phaseStart).every(value => value.status === "Passed"), "Desktop phases must all pass").toBe(true);
  });
  record();
  expect(claims.length > 0 && claims.every(value => value.status === "Passed"), "Failed/Incomplete phases remain red; see per-user-home receipts").toBe(true);
});
