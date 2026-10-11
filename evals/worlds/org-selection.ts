import { callFunctionOnSurface, type Surface } from "@openwork/cdp";
import { createOrg, localMysqlIsRunning, localRedisIsRunning, needs, SkipError, type Seed } from "@openwork/env";
import { documentOverflow, popupPaintState } from "../helpers/ui-witnesses.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function organizationDirectory(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.orgs)) throw new Error("Expected organization directory");
  const orgs = value.orgs.map((org: unknown) => {
    if (!isRecord(org) || typeof org.id !== "string" || typeof org.name !== "string") {
      throw new Error("Expected organization identity");
    }
    return { id: org.id, name: org.name };
  });
  return { orgs, activeOrgId: typeof value.activeOrgId === "string" ? value.activeOrgId : null };
}

export async function orgSelection(seed: Seed, { place }: { place: { kind: "local" | "daytona" } }) {
  if (place.kind === "local" && !process.env.OPENWORK_EVAL_DEN_API_URL) {
    needs({ commands: ["pnpm", "bun"] });
    if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306; run pnpm dev:den:mysql");
    if (!await localRedisIsRunning()) throw new SkipError("Redis at DATABASE_REDIS_URL or redis://127.0.0.1:6379");
  }
  const firstName = "Example Design Team";
  const secondName = "Example Research Team";
  const den = await seed.den({
    env: {
      DEN_ORG_MODE: "multi_org",
      DEN_REQUIRE_EMAIL_VERIFICATION: "false",
      OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "",
      SMTP_HOST: "",
    },
    org: {
      name: firstName,
      admin: {
        name: "Alex Example",
        email: `org-selection-${Date.now()}@example.test`,
        password: "OpenWork-selection-4821!proof",
      },
    },
  });
  const created = await seed.api(den.admin, "/v1/org", {
    method: "POST", body: JSON.stringify({ name: secondName }),
  });
  if (!created.response.ok) throw new Error(`Second organization: HTTP ${created.response.status}`);
  const listed = await seed.api(den.admin, "/v1/me/orgs");
  if (!listed.response.ok) throw new Error(`Organization directory: HTTP ${listed.response.status}`);
  const directory = organizationDirectory(listed.body);
  const first = directory.orgs.find((org) => org.name === firstName);
  const second = directory.orgs.find((org) => org.name === secondName);
  if (!first || !second || directory.orgs.length !== 2) throw new Error("Expected exactly two isolated organizations");
  // The chooser switches organizations through Better Auth's cookie-authenticated
  // endpoint. seed.web(signedInAs) supplies only localStorage's bearer token, so
  // seed both credentials from one real sign-in and observe that same session.
  const signedIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
    method: "POST", body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  if (!signedIn.response.ok || !isRecord(signedIn.body) || typeof signedIn.body.token !== "string") {
    throw new Error(`Browser sign-in: HTTP ${signedIn.response.status}`);
  }
  const owner = { ...den.admin, token: signedIn.body.token };
  const sessionCookie = signedIn.response.headers.getSetCookie()
    .find((value) => value.split(";")[0]?.split("=")[0]?.endsWith("session_token"))?.split(";")[0] ?? "";
  const separator = sessionCookie.indexOf("=");
  if (separator < 1) throw new Error("Browser sign-in did not return a session cookie");
  const selected = await seed.api(owner, "/v1/me/active-organization", {
    method: "POST", body: JSON.stringify({ organizationId: first.id }),
  });
  if (!selected.response.ok) throw new Error(`Initial organization: HTTP ${selected.response.status}`);

  // ENG-646: enter through AuthScreen, not a direct /dashboard document load.
  // An already-active org means the chooser must come from the real auth
  // client's pending-selection handshake, not merely a missing active org.
  // No injected picker state, mocked React hooks, or forced client navigation.
  const web = await seed.web({ den, signedInAs: owner, startPath: "/", headless: true });
  const applied = await web.client.send("Network.setCookie", {
    name: sessionCookie.slice(0, separator),
    value: sessionCookie.slice(separator + 1),
    url: den.ref.webUrl,
    path: "/",
    httpOnly: true,
    secure: new URL(den.ref.webUrl).protocol === "https:",
  });
  if (!isRecord(applied) || applied.success !== true) throw new Error("Could not seed the browser session cookie");
  return {
    den, web, owner, first, second,
    // TODO(primitive): probe has no document identity observer. A read-only
    // timeOrigin witness catches full reloads that would mask hook-order bugs.
    async documentStartedAt(): Promise<number> {
      const value = await seed.evalIn(web, () => performance.timeOrigin);
      if (typeof value !== "number") throw new Error("Expected a document time origin");
      return value;
    },
  };
}

export function workspaceMemberships(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.orgs)) throw new Error("Expected workspace memberships");
  const orgs = value.orgs.map((org: unknown) => {
    if (!isRecord(org) || typeof org.id !== "string" || typeof org.name !== "string"
      || typeof org.slug !== "string" || typeof org.role !== "string" || typeof org.membershipId !== "string") {
      throw new Error("Expected an authorized workspace identity and membership");
    }
    return { id: org.id, name: org.name, slug: org.slug, role: org.role, membershipId: org.membershipId };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return { orgs, activeOrgId: typeof value.activeOrgId === "string" ? value.activeOrgId : null };
}

/**
 * Fixed read-only witness. see/click can scroll a covered target into view;
 * inspect native hit targets immediately after OPENING, before either touches
 * the popup. No DOM/style injection, focus, scrolling, or manual coordinates.
 * probe.dom does not expose clipping ancestors, scroll demand or native hits.
 */
async function readWorkspaceSwitcher(surface: Surface, authorizedNames: string[]) {
  const measured = await callFunctionOnSurface(surface, (serializedNames) => {
    if (typeof serializedNames !== "string") throw new Error("Expected serialized workspace names");
    const namesValue: unknown = JSON.parse(serializedNames);
    if (!Array.isArray(namesValue) || !namesValue.every((name) => typeof name === "string")) throw new Error("Expected authorized workspace names");
    const authorizedNames = namesValue.filter((name: unknown): name is string => typeof name === "string");
    const rendered = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const menus = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-switcher-menu"]')).filter(rendered);
    const menu = menus[0];
    const trigger = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-switcher-trigger"]')).find(rendered);
    if (!menu || !trigger) throw new Error("The open workspace switcher has not rendered");
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const inspect = (element: Element | undefined | null) => {
      if (!element) return null;
      const box = rect(element);
      const x = (box.left + box.right) / 2;
      const y = (box.top + box.bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        ...box, text: element.textContent?.trim().replace(/\s+/g, " ") ?? "",
        hitTest: hit !== null && (hit === element || element.contains(hit)),
        focused: document.activeElement === element,
        disabled: element.matches(":disabled"),
      };
    };
    const buttons = Array.from(menu.querySelectorAll("button"));
    const rows = buttons.filter((button) => authorizedNames.some((name) => button.textContent?.includes(name)));
    const list = rows[0]?.parentElement;
    const clippingAncestors = [];
    for (let ancestor = menu.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if ([style.overflowX, style.overflowY].some((value) => ["hidden", "clip", "auto", "scroll"].includes(value))) {
        clippingAncestors.push({ tag: ancestor.tagName.toLowerCase(), overflowX: style.overflowX, overflowY: style.overflowY, ...rect(ancestor) });
      }
    }
    const create = Array.from(menu.querySelectorAll("a")).find((link) => link.textContent?.includes("Create or join workspace"));
    return {
      viewport: { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth },
      visibleMenuCount: menus.length,
      menu: { ...rect(menu), scrollTop: menu.scrollTop, scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight },
      trigger: inspect(trigger),
      email: inspect(menu.querySelector("p")),
      search: inspect(menu.querySelector('input[placeholder="Search workspaces"]')),
      firstWorkspace: inspect(rows[0]),
      showMore: inspect(buttons.find((button) => button.textContent?.trim().startsWith("Show more"))),
      create: inspect(create), createHref: create?.getAttribute("href") ?? null,
      signOut: inspect(buttons.find((button) => button.textContent?.trim() === "Sign out")),
      workspaceNames: rows.map((row) => authorizedNames.find((name) => row.textContent?.includes(name)) ?? ""),
      list: list ? { ...rect(list), scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, overflowY: getComputedStyle(list).overflowY } : null,
      focusInside: document.activeElement !== null && menu.contains(document.activeElement),
      // Read motion without changing its timeline. The drawer can still be
      // translating when the trusted opening click has already completed.
      motionRunning: [...menu.getAnimations({ subtree: true }), ...(trigger.closest("aside")?.getAnimations({ subtree: true }) ?? [])]
        .some((animation) => animation.playState === "running"),
      clippingAncestors,
    };
  }, [JSON.stringify(authorizedNames)]);
  const overflow = await documentOverflow(surface);
  return { ...measured, viewport: { ...measured.viewport, documentWidth: overflow.documentWidth, clientWidth: overflow.clientWidth } };
}

export type WorkspaceSwitcherMeasurements = Awaited<ReturnType<typeof readWorkspaceSwitcher>>;

/** Extend the owner selection journey with real, authorized long-list choices. */
export async function workspaceSwitcherLayout(seed: Seed, { place }: { place: { kind: "local" | "daytona" } }) {
  // Never arrange fictional workspaces against a connected production Den.
  // Reuse is allowed only for the caller's disposable loopback test service.
  const reuse = process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
  if (reuse && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(reuse).hostname)) {
    throw new SkipError("a disposable Den: unset OPENWORK_EVAL_DEN_API_URL or use the local test service");
  }
  if (place.kind === "local" && !reuse) {
    needs({ commands: ["pnpm", "bun"] });
    if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306; run pnpm dev:den:mysql");
    if (!await localRedisIsRunning()) throw new SkipError("Redis at DATABASE_REDIS_URL or redis://127.0.0.1:6379");
  }
  const names = Array.from({ length: 24 }, (_, index) => `Example Layout Workspace ${String(index + 1).padStart(2, "0")}`);
  const firstName = names[0];
  if (!firstName) throw new Error("Missing initial fictional workspace");
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const password = "OpenWork-switcher-4821!proof";
  const den = await seed.den({
    env: {
      DEN_ORG_MODE: "multi_org", DEN_REQUIRE_EMAIL_VERIFICATION: "false", OPENWORK_DEV_MODE: "1",
      RESEND_API_KEY: "", SMTP_HOST: "",
    },
    org: { name: firstName, admin: { name: "Alex Example", email: `switcher-owner-${stamp}@example.test`, password } },
  });
  const extraOrganizations = new AsyncDisposableStack();
  try {
    // The existing fixture API creates genuine owner memberships. Its handles
    // clean up every extra organization even when the caller reuses local Den.
    for (const name of names.slice(1)) extraOrganizations.use(await createOrg(den, name));

    const outsidePerson = { name: "Riley Example", email: `switcher-outside-${stamp}@example.test`, password };
    const signedUp = await seed.api(den.admin, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify(outsidePerson) });
    if (!signedUp.response.ok) throw new Error(`Outside account: HTTP ${signedUp.response.status}`);
    const outsideSignIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
      method: "POST", body: JSON.stringify({ email: outsidePerson.email, password }),
    });
    if (!outsideSignIn.response.ok || !isRecord(outsideSignIn.body) || typeof outsideSignIn.body.token !== "string") {
      throw new Error(`Outside sign-in: HTTP ${outsideSignIn.response.status}`);
    }
    const outsider = { ...den.ref, email: outsidePerson.email, password, token: outsideSignIn.body.token };
    const outside = extraOrganizations.use(await createOrg({ ...den, admin: outsider }, "Outside Example Workspace"));

    const signedIn = await seed.api(den.admin, "/api/auth/sign-in/email", {
      method: "POST", headers: { origin: den.ref.webUrl }, body: JSON.stringify({ email: den.admin.email, password }),
    });
    if (!signedIn.response.ok || !isRecord(signedIn.body) || typeof signedIn.body.token !== "string") {
      throw new Error(`Browser sign-in: HTTP ${signedIn.response.status}`);
    }
    const owner = { ...den.admin, token: signedIn.body.token };
    const listed = await seed.api(owner, "/v1/me/orgs");
    if (!listed.response.ok) throw new Error(`Authorized workspaces: HTTP ${listed.response.status}`);
    const initial = workspaceMemberships(listed.body);
    if (initial.orgs.length !== names.length || initial.orgs.some((org) => !names.includes(org.name))) {
      throw new Error("Expected exactly 24 isolated, authorized workspaces");
    }
    const first = initial.orgs.find((org) => org.name === firstName);
    const last = initial.orgs.find((org) => org.name === names.at(-1));
    if (!first || !last || initial.orgs.some((org) => org.id === outside.id)) throw new Error("Workspace membership isolation failed");
    const selected = await seed.api(owner, "/v1/me/active-organization", {
      method: "POST", body: JSON.stringify({ organizationId: first.id }),
    });
    if (!selected.response.ok) throw new Error(`Initial workspace: HTTP ${selected.response.status}`);
    const cookie = signedIn.response.headers.getSetCookie()
      .find((value) => value.split(";")[0]?.split("=")[0]?.endsWith("session_token"))?.split(";")[0] ?? "";
    const separator = cookie.indexOf("=");
    if (separator < 1) throw new Error("Browser sign-in did not return a session cookie");
    // All 25 real workspaces and both identities exist BEFORE the first browser act.
    const web = await seed.web({ den, signedInAs: owner, startPath: "/dashboard", headless: true, viewport: { width: 667, height: 375 } });
    const applied = await web.client.send("Network.setCookie", {
      name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: den.ref.webUrl, path: "/",
      httpOnly: true, secure: new URL(den.ref.webUrl).protocol === "https:",
    });
    if (!isRecord(applied) || applied.success !== true) throw new Error("Could not seed the owner browser cookie");
    return {
      den, web, owner, outsider, outside: { id: outside.id, name: outside.name }, first, last,
      initialMemberships: initial.orgs,
      measurements: () => readWorkspaceSwitcher(web, names),
      menuPaintState: () => popupPaintState(web, '[data-testid="workspace-switcher-menu"]', '[data-testid="workspace-switcher-trigger"]'),
      async [Symbol.asyncDispose]() { await extraOrganizations.disposeAsync(); },
    };
  } catch (error) {
    await extraOrganizations.disposeAsync();
    throw error;
  }
}
