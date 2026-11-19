import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  initializeDenBootstrapConfig,
  readDenSettings,
  setDenBootstrapConfig,
  writeDenSettings,
} from "../src/app/lib/den";
import { exchangeHandoffAndSignIn } from "../src/app/lib/den-handoff";
import { readOrgSelectionPending } from "../src/app/lib/den-sign-in-intent";
import {
  SIGN_IN_RETURN_STORAGE_KEY,
  SIGN_IN_RETURN_TTL_MS,
  beginSignInReturn,
  claimSignInReturnDraft,
  claimSignInReturnRoute,
  clearSignInReturnTarget,
  isReturnablePath,
  noteSignInReturnHandoff,
  readSignInReturnTarget,
  recordSignInReturnTarget,
  resolvePostHandoffRoute,
  sessionRouteIds,
  shouldHandleSignInReturnAttempt,
  type SignInReturnStorage,
} from "../src/app/lib/den-sign-in-return";
import { openAutoSignIn } from "../src/react-app/domains/cloud/auto-access-ui";
import { completeSignInReturn } from "../src/react-app/domains/cloud/sign-in-return";
import { carrySignInReturnDraft, hasSignedOutDraft } from "../src/react-app/domains/cloud/sign-in-return-draft";
import {
  cloudSessionDraftScope,
  getSessionDraft,
  LOCAL_SESSION_DRAFT_SCOPE,
  NEW_TASK_DRAFT_SESSION_ID,
  saveSessionDraft,
} from "../src/react-app/domains/session/sync/draft-store";

const T0 = 1_800_000_000_000;
const conversation = "/workspace/ws_local/session/ses_contract";
const authUrl = "https://den.example.test/?mode=sign-up&desktopAuth=1&desktopScheme=openwork";

function memoryStorage(): SignInReturnStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("return target", () => {
  test("records the conversation on screen and reads it back", () => {
    const storage = memoryStorage();
    const target = recordSignInReturnTarget({ path: conversation, pendingTurn: true, authUrl }, T0, storage);
    expect(target).toMatchObject({ path: conversation, workspaceId: "ws_local", sessionId: "ses_contract", pendingTurn: true, authUrl, signedInAt: null });
    expect(readSignInReturnTarget(T0 + 1_000, storage)).toEqual(target);
  });

  test("names the new-task screen's workspace when the route does not", () => {
    const storage = memoryStorage();
    const target = recordSignInReturnTarget({ path: "/session", workspaceId: "ws_local", sessionId: null }, T0, storage);
    expect(target).toMatchObject({ path: "/session", workspaceId: "ws_local", sessionId: null, pendingTurn: false });
    expect(sessionRouteIds("/workspace/ws%20a/session")).toEqual({ workspaceId: "ws a", sessionId: null });
    expect(sessionRouteIds("/settings/cloud-account")).toEqual({ workspaceId: null, sessionId: null });
  });

  test("expires after 30 minutes and removes itself", () => {
    const storage = memoryStorage();
    recordSignInReturnTarget({ path: conversation }, T0, storage);
    expect(readSignInReturnTarget(T0 + SIGN_IN_RETURN_TTL_MS, storage)).not.toBeNull();
    expect(readSignInReturnTarget(T0 + SIGN_IN_RETURN_TTL_MS + 1, storage)).toBeNull();
    expect(storage.values.has(SIGN_IN_RETURN_STORAGE_KEY)).toBe(false);
  });

  test("never returns to a sign-in surface or another origin", () => {
    const storage = memoryStorage();
    for (const path of ["/onboarding", "/signin", "/welcome", "//evil.example.test/x", "https://evil.example.test"]) {
      expect(isReturnablePath(path)).toBe(false);
      expect(recordSignInReturnTarget({ path }, T0, storage)).toBeNull();
    }
    expect(storage.values.size).toBe(0);
  });

  test("an unreadable record is dropped", () => {
    const storage = memoryStorage();
    storage.setItem(SIGN_IN_RETURN_STORAGE_KEY, JSON.stringify({ version: 1, path: conversation }));
    expect(readSignInReturnTarget(T0, storage)).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  test("only a desktop-initiated sign-in completes it; a remote handoff drops it", () => {
    const storage = memoryStorage();
    recordSignInReturnTarget({ path: conversation }, T0, storage);
    expect(claimSignInReturnRoute(T0 + 1, storage)).toBeNull();
    expect(noteSignInReturnHandoff({ desktopInitiated: false }, T0 + 2, storage)).toBeNull();
    expect(readSignInReturnTarget(T0 + 3, storage)).toBeNull();

    recordSignInReturnTarget({ path: conversation }, T0, storage);
    expect(noteSignInReturnHandoff({ desktopInitiated: true }, T0 + 2, storage)?.signedInAt).toBe(T0 + 2);
  });

  test("the route and the draft are each consumed exactly once", () => {
    const storage = memoryStorage();
    recordSignInReturnTarget({ path: conversation }, T0, storage);
    noteSignInReturnHandoff({ desktopInitiated: true }, T0 + 1, storage);
    expect(claimSignInReturnRoute(T0 + 2, storage)?.path).toBe(conversation);
    expect(claimSignInReturnRoute(T0 + 3, storage)).toBeNull();
    expect(claimSignInReturnDraft(T0 + 4, storage)?.sessionId).toBe("ses_contract");
    expect(claimSignInReturnDraft(T0 + 5, storage)).toBeNull();
    expect(storage.values.size).toBe(0);
  });
});

describe("where a successful handoff lands", () => {
  const signedIn = (storage: SignInReturnStorage, now = T0 + 1) => {
    recordSignInReturnTarget({ path: conversation }, T0, storage);
    return noteSignInReturnHandoff({ desktopInitiated: true }, now, storage);
  };

  test("several organizations: the chooser first, then back to the conversation", () => {
    const storage = memoryStorage();
    const target = signedIn(storage);
    expect(resolvePostHandoffRoute({ hasToken: true, activeOrgId: null, orgSelectionPending: true, target })).toEqual({ kind: "onboarding", path: "/onboarding" });
    // Org onboarding finishes with the organization chosen.
    expect(resolvePostHandoffRoute({ hasToken: true, activeOrgId: "org-a", orgSelectionPending: false, target: readSignInReturnTarget(T0 + 2, storage) }))
      .toEqual({ kind: "return", path: conversation });
  });

  test("one organization or a remembered one: straight back to the conversation", () => {
    const storage = memoryStorage();
    const target = signedIn(storage);
    expect(resolvePostHandoffRoute({ hasToken: true, activeOrgId: "org-a", orgSelectionPending: false, target })).toEqual({ kind: "return", path: conversation });
  });

  test("no target, an expired one, or one never completed: today's session root", () => {
    const storage = memoryStorage();
    expect(resolvePostHandoffRoute({ hasToken: true, activeOrgId: "org-a", orgSelectionPending: false, target: null })).toEqual({ kind: "default", path: "/session" });
    signedIn(storage);
    const expired = readSignInReturnTarget(T0 + SIGN_IN_RETURN_TTL_MS + 1, storage);
    expect(resolvePostHandoffRoute({ hasToken: true, activeOrgId: "org-a", orgSelectionPending: false, target: expired })).toEqual({ kind: "default", path: "/session" });
    const unfinished = recordSignInReturnTarget({ path: conversation }, T0, storage);
    expect(resolvePostHandoffRoute({ hasToken: true, activeOrgId: "org-a", orgSelectionPending: false, target: unfinished })).toEqual({ kind: "default", path: "/session" });
  });

  test("a delayed success redirect cannot replay onboarding's return or a superseded attempt", () => {
    const storage = memoryStorage();
    const attempt = signedIn(storage);
    expect(shouldHandleSignInReturnAttempt(attempt, readSignInReturnTarget(T0 + 2, storage))).toBe(true);
    claimSignInReturnRoute(T0 + 3, storage);
    expect(shouldHandleSignInReturnAttempt(attempt, readSignInReturnTarget(T0 + 4, storage))).toBe(false);
    claimSignInReturnDraft(T0 + 5, storage);
    expect(shouldHandleSignInReturnAttempt(attempt, readSignInReturnTarget(T0 + 6, storage))).toBe(false);
    const newer = recordSignInReturnTarget({ path: conversation }, T0 + 7, storage);
    expect(shouldHandleSignInReturnAttempt(attempt, newer)).toBe(false);
    expect(shouldHandleSignInReturnAttempt(null, newer)).toBe(false);
    // A sign-in with no return attempt still uses the existing default landing.
    expect(shouldHandleSignInReturnAttempt(null, null)).toBe(true);
  });

  test("waits while the organization is still resolving", () => {
    expect(resolvePostHandoffRoute({ hasToken: true, activeOrgId: " ", orgSelectionPending: false, target: null })).toBeNull();
    expect(resolvePostHandoffRoute({ hasToken: false, activeOrgId: "org-a", orgSelectionPending: false, target: null })).toBeNull();
  });
});

describe("starting sign-in from a conversation", () => {
  test("records the target and opens the browser without leaving the route", () => {
    const storage = memoryStorage();
    const openLink = mock((_url: string) => {});
    const markDesktopSignInInitiated = mock(() => {});
    const fallback = mock(() => {});
    const result = beginSignInReturn({ path: conversation, authUrl, pendingTurn: true }, { openLink, markDesktopSignInInitiated, fallback, now: T0, storage });
    expect(result).toBe("in-place");
    expect(fallback).not.toHaveBeenCalled();
    expect(openLink).toHaveBeenCalledWith(authUrl);
    expect(markDesktopSignInInitiated).toHaveBeenCalledTimes(1);
    expect(readSignInReturnTarget(T0, storage)).toMatchObject({ path: conversation, pendingTurn: true });
  });

  test("unavailable storage still opens sign-in without retaining a return target", () => {
    const openLink = mock((_url: string) => {});
    const fallback = mock(() => {});
    expect(beginSignInReturn({ path: conversation, authUrl }, { openLink, markDesktopSignInInitiated: () => {}, fallback, storage: null })).toBe("in-place");
    expect(fallback).not.toHaveBeenCalled();
    expect(openLink).toHaveBeenCalledWith(authUrl);
    expect(readSignInReturnTarget(T0, null)).toBeNull();
  });

  test("from a sign-in surface it keeps the existing behaviour", () => {
    const storage = memoryStorage();
    const fallback = mock(() => {});
    expect(beginSignInReturn({ path: "/onboarding", authUrl }, { openLink: () => {}, markDesktopSignInInitiated: () => {}, fallback, now: T0, storage })).toBe("fallback");
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe("in the app", () => {
  const baseUrl = "https://den.example.test";
  const user = { id: "user-riley", email: "riley@acme.example", name: "Riley" };
  const acme = { id: "org-acme", name: "Acme", slug: "acme", role: "owner" };
  const other = { id: "org-other", name: "Riley's workspace", slug: "riley", role: "owner" };

  beforeEach(async () => {
    GlobalRegistrator.register({ url: "http://localhost:5173/" });
    await initializeDenBootstrapConfig();
    await setDenBootstrapConfig({ baseUrl, apiBaseUrl: baseUrl });
  });
  afterEach(async () => {
    clearSignInReturnTarget();
    await GlobalRegistrator.unregister();
  });

  test("Auto's Sign in always keeps the conversation on screen", () => {
    window.location.hash = `#${conversation}`;
    const openLink = mock((_url: string) => {});
    const signIn = (request: { pendingTurn?: boolean; fallback?: () => void }) => beginSignInReturn(
      { path: conversation, authUrl, pendingTurn: request.pendingTurn },
      { openLink, markDesktopSignInInitiated: () => {}, fallback: request.fallback ?? (() => {}) },
    );
    openAutoSignIn(undefined, signIn, { workspaceId: "ws_local", sessionId: "ses_contract" });
    expect(window.location.hash).toBe(`#${conversation}`);
    expect(openLink).toHaveBeenCalledWith(authUrl);
    expect(readSignInReturnTarget()?.path).toBe(conversation);
  });

  test("a desktop sign-in with several organizations holds the choice, then returns once with the org named", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/v1/auth/desktop-handoff/exchange")) return Response.json({ user, token: "riley-session", organization: acme });
      if (url.pathname.endsWith("/v1/me/orgs")) return Response.json({ orgs: [acme, other], activeOrgId: acme.id });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    try {
      recordSignInReturnTarget({ path: conversation, authUrl });
      const result = await exchangeHandoffAndSignIn("riley-grant", { baseUrl, apiBaseUrl: baseUrl, desktopInitiated: true });
      expect(result.ok).toBe(true);
      expect(readOrgSelectionPending().pending).toBe(true);
      const target = readSignInReturnTarget();
      expect(target?.signedInAt).not.toBeNull();
      expect(resolvePostHandoffRoute({ hasToken: true, activeOrgId: readDenSettings().activeOrgId, orgSelectionPending: true, target })?.kind).toBe("onboarding");

      // The person chooses Acme in onboarding, which then finishes.
      writeDenSettings({ ...readDenSettings(), activeOrgId: acme.id, activeOrgSlug: acme.slug, activeOrgName: acme.name }, { persistBootstrap: false });
      const navigate = mock((_path: string, _options?: { replace?: boolean }) => {});
      expect(completeSignInReturn(navigate)).toBe(true);
      expect(navigate).toHaveBeenCalledWith(conversation, { replace: true });
      expect(completeSignInReturn(navigate)).toBe(false);
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  });

  test("a remotely initiated handoff never reuses a stale target", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/v1/auth/desktop-handoff/exchange")) return Response.json({ user: { ...user, id: "user-jordan" }, token: "jordan-session", organization: acme });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    try {
      recordSignInReturnTarget({ path: conversation, authUrl });
      const result = await exchangeHandoffAndSignIn("jordan-grant", { baseUrl, apiBaseUrl: baseUrl, desktopInitiated: false });
      expect(result.ok).toBe(true);
      expect(readSignInReturnTarget()).toBeNull();
      const navigate = mock((_path: string) => {});
      expect(completeSignInReturn(navigate)).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  test("sign-in never assigns an unowned draft without explicit account-bound consent", () => {
    const riley = { principalId: user.id, organizationId: acme.id };
    const jordan = { principalId: "user-jordan", organizationId: acme.id };
    const scope = cloudSessionDraftScope(riley)!;
    const jordanScope = cloudSessionDraftScope(jordan)!;
    saveSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, "ws_local", "ses_contract", { text: "List the renewal dates", mode: "prompt" });
    const target = recordSignInReturnTarget({ path: conversation, authUrl })!;
    const confirmation = { scope, startedAt: target.startedAt };
    expect(carrySignInReturnDraft(riley, confirmation)).toBe(false);
    noteSignInReturnHandoff({ desktopInitiated: true });
    // Either account can finish sign-in, but neither receives the local draft.
    expect(carrySignInReturnDraft(riley)).toBe(false);
    expect(carrySignInReturnDraft(jordan)).toBe(false);
    expect(getSessionDraft(scope, "ws_local", "ses_contract")).toBeNull();
    expect(getSessionDraft(jordanScope, "ws_local", "ses_contract")).toBeNull();
    // Consent for another account or an earlier attempt cannot authorize it.
    expect(carrySignInReturnDraft(jordan, confirmation)).toBe(false);
    expect(carrySignInReturnDraft(riley, { ...confirmation, startedAt: target.startedAt - 1 })).toBe(false);
    expect(hasSignedOutDraft(target)).toBe(true);
    expect(carrySignInReturnDraft(riley, confirmation)).toBe(true);
    expect(getSessionDraft(scope, "ws_local", "ses_contract")?.text).toBe("List the renewal dates");
    expect(getSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, "ws_local", "ses_contract")).toBeNull();
    expect(carrySignInReturnDraft(riley, confirmation)).toBe(false);
    expect(carrySignInReturnDraft(jordan, { ...confirmation, scope: jordanScope })).toBe(false);
    expect(getSessionDraft(jordanScope, "ws_local", "ses_contract")).toBeNull();
  });

  test("declining keeps the draft signed out and confirmation never overwrites an account draft", () => {
    const identity = { principalId: user.id, organizationId: acme.id };
    const scope = cloudSessionDraftScope(identity)!;
    saveSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, "ws_local", NEW_TASK_DRAFT_SESSION_ID, { text: "signed-out prompt", mode: "prompt" });
    saveSessionDraft(scope, "ws_local", NEW_TASK_DRAFT_SESSION_ID, { text: "already here", mode: "prompt" });
    const target = recordSignInReturnTarget({ path: "/workspace/ws_local/session" })!;
    noteSignInReturnHandoff({ desktopInitiated: true });
    expect(carrySignInReturnDraft(identity, { scope, startedAt: target.startedAt })).toBe(false);
    expect(getSessionDraft(scope, "ws_local", NEW_TASK_DRAFT_SESSION_ID)?.text).toBe("already here");
    expect(hasSignedOutDraft(target)).toBe(true);
    recordSignInReturnTarget({ path: conversation, authUrl });
    saveSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, "ws_local", "ses_contract", { text: "private local draft", mode: "prompt" });
    noteSignInReturnHandoff({ desktopInitiated: true });
    // The secondary action consumes the choice without moving or deleting data.
    claimSignInReturnDraft();
    expect(carrySignInReturnDraft(identity)).toBe(false);
    expect(getSessionDraft(scope, "ws_local", "ses_contract")).toBeNull();
    expect(getSessionDraft(LOCAL_SESSION_DRAFT_SCOPE, "ws_local", "ses_contract")?.text).toBe("private local draft");
  });
});
