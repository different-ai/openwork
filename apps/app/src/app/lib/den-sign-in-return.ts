// Where an in-app sign-in comes back to.
//
// A person who signs in from a conversation should land back in that same
// conversation, with their draft and model, instead of on the session root.
// The browser handoff can take minutes and may go through organization
// selection, so the place to return to is recorded when sign-in starts and
// consumed once the handoff commits:
//
//   start      an in-app entry point records the route (and its workspace and
//              conversation) and opens the browser without leaving the route
//   handoff    a desktop-initiated exchange marks the target as signed in; a
//              remotely initiated one (install link, "Open in desktop")
//              drops it, so a stale target is never reused
//   return     once an organization is active, chat opens on the recorded
//              route instead of the session root (directly, or when org
//              onboarding finishes), exactly once
//   draft      once the new identity is verified, explicit confirmation can
//              move the unowned signed-out draft into that account, once
//
// Targets expire after 30 minutes; anything older falls back to the default
// landing. Another sign-in entry point (Settings, the forced sign-in page)
// clears the target when it starts its own attempt.

import { z } from "zod";

export const SIGN_IN_RETURN_STORAGE_KEY = "openwork.den.signInReturn.v1";
export const SIGN_IN_RETURN_TTL_MS = 30 * 60 * 1000;
export const signInReturnChangedEvent = "openwork-sign-in-return-changed";

const signInReturnTargetSchema = z.object({
  version: z.literal(1),
  path: z.string().regex(/^\/(?!\/)/),
  workspaceId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  /** A message the person already sent is waiting (rejected-turn recovery). */
  pendingTurn: z.boolean(),
  /** The browser sign-in link, for "Copy sign-in link". Not a credential. */
  authUrl: z.string().nullable(),
  startedAt: z.number().finite(),
  signedInAt: z.number().finite().nullable(),
  routed: z.boolean(),
  draftCarried: z.boolean(),
});

export type SignInReturnTarget = z.infer<typeof signInReturnTargetSchema>;

export type SignInReturnStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): SignInReturnStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function announce() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(signInReturnChangedEvent));
}

/** Sign-in surfaces themselves are never a place to come back to. */
const NON_RETURNABLE_PATHS = [/^\/signin(?:\/|$)/i, /^\/onboarding(?:\/|$)/i, /^\/welcome(?:\/|$)/i];

export function isReturnablePath(path: string): boolean {
  if (!/^\/(?!\/)/.test(path)) return false;
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  return !NON_RETURNABLE_PATHS.some((pattern) => pattern.test(pathname));
}

function decodeSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

/** The app route on screen: the hash route on desktop, the path in a browser. */
export function currentAppRoutePath(): string {
  if (typeof window === "undefined") return "/";
  const { hash, pathname, search } = window.location;
  return hash.startsWith("#/") ? hash.slice(1) : `${pathname}${search}`;
}

/** The workspace and conversation a session route points at, if any. */
export function sessionRouteIds(path: string): { workspaceId: string | null; sessionId: string | null } {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  const scoped = pathname.match(/^\/workspace\/([^/]+)\/session(?:\/([^/]+))?\/?$/);
  if (scoped) return { workspaceId: decodeSegment(scoped[1]), sessionId: decodeSegment(scoped[2]) };
  const bare = pathname.match(/^\/session(?:\/([^/]+))?\/?$/);
  if (bare) return { workspaceId: null, sessionId: decodeSegment(bare[1]) };
  return { workspaceId: null, sessionId: null };
}

export function isSignInReturnTargetLive(target: SignInReturnTarget, now: number): boolean {
  return Math.abs(now - target.startedAt) <= SIGN_IN_RETURN_TTL_MS;
}

export function parseSignInReturnTarget(raw: string | null, now: number): SignInReturnTarget | null {
  if (!raw) return null;
  try {
    const parsed = signInReturnTargetSchema.safeParse(JSON.parse(raw));
    return parsed.success && isSignInReturnTargetLive(parsed.data, now) ? parsed.data : null;
  } catch {
    return null;
  }
}

function write(target: SignInReturnTarget, storage: SignInReturnStorage | null) {
  try {
    storage?.setItem(SIGN_IN_RETURN_STORAGE_KEY, JSON.stringify(target));
  } catch {
    // Storage may be unavailable; the sign-in still works and lands on the default route.
  }
  announce();
}

export function clearSignInReturnTarget(storage: SignInReturnStorage | null = browserStorage()) {
  try {
    if (storage?.getItem(SIGN_IN_RETURN_STORAGE_KEY) === null) return;
    storage?.removeItem(SIGN_IN_RETURN_STORAGE_KEY);
  } catch {
    return;
  }
  announce();
}

/** The live target, if any. An expired or unreadable one is removed. */
export function readSignInReturnTarget(
  now: number = Date.now(),
  storage: SignInReturnStorage | null = browserStorage(),
): SignInReturnTarget | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SIGN_IN_RETURN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  const target = parseSignInReturnTarget(raw, now);
  if (raw !== null && !target) clearSignInReturnTarget(storage);
  return target;
}

export type SignInReturnStart = {
  /** The route the person is on, including its query. */
  path: string;
  /** Used when the route itself names no workspace (the new-task screen). */
  workspaceId?: string | null;
  /** Used when the route itself names no conversation. */
  sessionId?: string | null;
  pendingTurn?: boolean;
  authUrl?: string | null;
};

export function recordSignInReturnTarget(
  input: SignInReturnStart,
  now: number = Date.now(),
  storage: SignInReturnStorage | null = browserStorage(),
): SignInReturnTarget | null {
  if (!isReturnablePath(input.path)) {
    clearSignInReturnTarget(storage);
    return null;
  }
  const fromPath = sessionRouteIds(input.path);
  const workspaceId = fromPath.workspaceId ?? input.workspaceId?.trim() ?? null;
  const target: SignInReturnTarget = {
    version: 1,
    path: input.path,
    workspaceId: workspaceId || null,
    sessionId: fromPath.sessionId ?? (fromPath.workspaceId ? null : input.sessionId?.trim() || null),
    pendingTurn: input.pendingTurn === true,
    authUrl: input.authUrl ?? null,
    startedAt: now,
    signedInAt: null,
    routed: false,
    draftCarried: false,
  };
  write(target, storage);
  return target;
}

/**
 * Called once a handoff commits. Only a desktop-initiated exchange (an in-app
 * button or a pasted code) completes the recorded attempt; a remotely
 * initiated one belongs to whatever link started it and drops the target.
 */
export function noteSignInReturnHandoff(
  input: { desktopInitiated: boolean },
  now: number = Date.now(),
  storage: SignInReturnStorage | null = browserStorage(),
): SignInReturnTarget | null {
  const target = readSignInReturnTarget(now, storage);
  if (!target) return null;
  if (!input.desktopInitiated) {
    clearSignInReturnTarget(storage);
    return null;
  }
  if (target.signedInAt !== null) return target;
  const next = { ...target, signedInAt: now };
  write(next, storage);
  return next;
}

function claim(
  part: "routed" | "draftCarried",
  now: number,
  storage: SignInReturnStorage | null,
): SignInReturnTarget | null {
  const target = readSignInReturnTarget(now, storage);
  if (!target || target.signedInAt === null || target[part]) return null;
  const next = { ...target, [part]: true };
  if (next.routed && next.draftCarried) clearSignInReturnTarget(storage);
  else write(next, storage);
  return target;
}

/** The route to open after sign-in, exactly once. */
export function claimSignInReturnRoute(now: number = Date.now(), storage: SignInReturnStorage | null = browserStorage()) {
  return claim("routed", now, storage);
}

/** The conversation whose signed-out draft moves into the signed-in scope, exactly once. */
export function claimSignInReturnDraft(now: number = Date.now(), storage: SignInReturnStorage | null = browserStorage()) {
  return claim("draftCarried", now, storage);
}

export function canReturnAfterSignIn(target: SignInReturnTarget | null): target is SignInReturnTarget {
  return Boolean(target && target.signedInAt !== null && !target.routed);
}

/** A delayed auth redirect cannot replay an already returned or replaced attempt. */
export function shouldHandleSignInReturnAttempt(attempt: SignInReturnTarget | null, current: SignInReturnTarget | null): boolean {
  if (!attempt) return current === null;
  return Boolean(current && current.startedAt === attempt.startedAt && !current.routed);
}

export type PostHandoffRoute =
  | { kind: "onboarding"; path: "/onboarding" }
  | { kind: "return"; path: string }
  | { kind: "default"; path: "/session" };

/**
 * Where a successful handoff lands once its credential is active. Org
 * onboarding still owns an open organization choice (it auto-continues for
 * one organization and returns to the target when it finishes); with an
 * organization active, chat opens on the recorded route instead of the
 * session root. Null means the organization is not resolved yet.
 */
export function resolvePostHandoffRoute(input: {
  hasToken: boolean;
  activeOrgId: string | null | undefined;
  orgSelectionPending: boolean;
  target: SignInReturnTarget | null;
}): PostHandoffRoute | null {
  if (!input.hasToken) return null;
  if (input.orgSelectionPending) return { kind: "onboarding", path: "/onboarding" };
  if (!input.activeOrgId?.trim()) return null;
  return canReturnAfterSignIn(input.target)
    ? { kind: "return", path: input.target.path }
    : { kind: "default", path: "/session" };
}

export type BeginSignInResult = "in-place" | "fallback";

/**
 * Starts an in-app sign-in, records where to return, marks it desktop-initiated
 * and opens the browser without leaving the route. Routes that cannot be
 * returned to keep the entry point's existing behavior. Without storage, sign-in
 * still opens and finishes on the default route.
 */
export function beginSignInReturn(
  request: SignInReturnStart & { authUrl: string },
  deps: {
    openLink: (url: string) => void;
    markDesktopSignInInitiated: () => void;
    fallback: () => void;
    now?: number;
    storage?: SignInReturnStorage | null;
  },
): BeginSignInResult {
  if (!isReturnablePath(request.path)) {
    deps.fallback();
    return "fallback";
  }
  const recorded = recordSignInReturnTarget(request, deps.now ?? Date.now(), deps.storage === undefined ? browserStorage() : deps.storage);
  if (!recorded) {
    deps.fallback();
    return "fallback";
  }
  deps.markDesktopSignInInitiated();
  deps.openLink(request.authUrl);
  return "in-place";
}

export function subscribeSignInReturn(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SIGN_IN_RETURN_STORAGE_KEY) listener();
  };
  window.addEventListener(signInReturnChangedEvent, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(signInReturnChangedEvent, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function readSignInReturnRaw(storage: SignInReturnStorage | null = browserStorage()): string | null {
  try {
    return storage?.getItem(SIGN_IN_RETURN_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}
