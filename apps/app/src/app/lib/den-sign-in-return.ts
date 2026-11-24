import { z } from "zod";

export const SIGN_IN_RETURN_STORAGE_KEY = "openwork.den.signInReturn.v1";
export const SIGN_IN_RETURN_TTL_MS = 30 * 60 * 1000;
export const signInReturnChangedEvent = "openwork-sign-in-return-changed";

const signInReturnTargetSchema = z.object({
  version: z.literal(1),
  path: z.string().regex(/^\/(?!\/)/),
  workspaceId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  pendingTurn: z.boolean(),
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

export function currentAppRoutePath(): string {
  if (typeof window === "undefined") return "/";
  const { hash, pathname, search } = window.location;
  return hash.startsWith("#/") ? hash.slice(1) : `${pathname}${search}`;
}

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
  path: string;
  workspaceId?: string | null;
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

export function claimSignInReturnRoute(now: number = Date.now(), storage: SignInReturnStorage | null = browserStorage()) {
  return claim("routed", now, storage);
}

export function claimSignInReturnDraft(now: number = Date.now(), storage: SignInReturnStorage | null = browserStorage()) {
  return claim("draftCarried", now, storage);
}

export function canReturnAfterSignIn(target: SignInReturnTarget | null): target is SignInReturnTarget {
  return Boolean(target && target.signedInAt !== null && !target.routed);
}

export function shouldHandleSignInReturnAttempt(attempt: SignInReturnTarget | null, current: SignInReturnTarget | null): boolean {
  if (!attempt) return current === null;
  return Boolean(current && current.startedAt === attempt.startedAt && !current.routed);
}

export type PostHandoffRoute =
  | { kind: "onboarding"; path: "/onboarding" }
  | { kind: "return"; path: string }
  | { kind: "default"; path: "/session" };

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
