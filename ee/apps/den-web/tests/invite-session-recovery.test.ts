import { expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type FormEvent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import * as navigation from "next/navigation";
import { JoinOrgScreen } from "../app/(den)/_components/join-org-screen";
import * as requests from "../app/(den)/_lib/den-flow";
import { PENDING_ORG_INVITATION_STORAGE_KEY } from "../app/(den)/_lib/den-org";
import * as runtime from "../app/(den)/_lib/runtime-config";
import { DenFlowProvider, useDenFlow } from "../app/(den)/_providers/den-flow-provider";

// ENG-550: an invitee whose unfinished sign-up left an unverified account
// signs in from the invite, gets a code, and verifies it. Den's verify-email
// reply carries the user but `token: null` and no cookie, so it is not a
// session. The flow must exchange the password for one before it treats the
// person as signed in, and the invite page must never strand a person whose
// session is gone behind a raw "unauthorized".

const account = { id: "user-1", email: "invitee@example.test", name: "Invitee" };
const password = "Correct-Horse-Battery-9";
const invitationToken = "invite-token";

type Reply = { status?: number; payload: unknown };
type Flow = ReturnType<typeof useDenFlow>;

async function mount(
  reply: (path: string) => Reply,
  child: ReactElement,
  check: (fixture: { container: HTMLElement; paths: string[] }) => Promise<void>,
) {
  GlobalRegistrator.register({ url: `https://app.example.test/join-org?invite=${invitationToken}` });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  sessionStorage.setItem(PENDING_ORG_INVITATION_STORAGE_KEY, invitationToken);
  const paths: string[] = [];
  spyOn(navigation, "usePathname").mockReturnValue("/join-org");
  spyOn(navigation, "useRouter").mockReturnValue({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch: async () => {} });
  spyOn(runtime, "getRuntimeConfig").mockResolvedValue({ ...runtime.EMPTY_RUNTIME_CONFIG, orgMode: "multi_org" });
  spyOn(requests, "requestJson").mockImplementation(async (path) => {
    paths.push(path);
    const { status = 200, payload } = reply(path);
    return { response: Response.json(payload, { status }), payload, text: JSON.stringify(payload) };
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(DenFlowProvider, null, child)); });
    await check({ container, paths });
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    await GlobalRegistrator.unregister();
  }
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function withFlow(
  reply: (path: string) => Reply,
  check: (fixture: { state: () => Flow; paths: string[]; submit: () => Promise<unknown> }) => Promise<void>,
) {
  let current: Flow | null = null;
  let submitted: Promise<unknown> = Promise.resolve(null);
  function Capture() {
    const flow = useDenFlow();
    current = flow;
    // Mirrors the auth panel form: the same submit verifies once a code is due.
    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
      submitted = flow.verificationRequired ? flow.submitVerificationCode(event) : flow.submitAuth(event);
    };
    return createElement("form", { onSubmit });
  }
  await mount(reply, createElement(Capture), async ({ container, paths }) => {
    await check({
      state: () => { if (!current) throw new Error("Flow not mounted"); return current; },
      paths,
      submit: async () => {
        await act(async () => {
          container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          await submitted;
        });
        return submitted;
      },
    });
  });
}

// Den as production answers it: no session until a password sign-in succeeds
// after the email is verified.
function den(options: { signUp?: boolean } = {}) {
  let verified = false;
  let signedIn = false;
  return (path: string): Reply => {
    if (path === "/v1/me") return signedIn ? { payload: { user: account } } : { status: 401, payload: { error: "unauthorized" } };
    if (path.startsWith("/api/auth/sso-resolve")) return { payload: { method: "password" } };
    if (path.startsWith("/api/auth/sign-up/email") && options.signUp) return { payload: { token: null, user: account } };
    if (path === "/api/auth/sign-in/email") {
      if (!verified) return { status: 403, payload: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" } };
      signedIn = true;
      return { payload: { redirect: false, token: "session-token", user: account } };
    }
    if (path === "/api/auth/email-otp/verify-email") {
      verified = true;
      return { payload: { status: true, token: null, user: account } };
    }
    return { payload: {} };
  };
}

async function reachVerification(state: () => Flow, submit: () => Promise<unknown>, mode: "sign-in" | "sign-up") {
  await act(async () => {
    state().setAuthMode(mode);
    state().setEmail(account.email);
    state().setAuthName(account.name);
    state().setPassword(password);
  });
  await submit();
  expect(state().verificationRequired).toBe(true);
  expect(state().user).toBeNull();
  await act(async () => state().setVerificationCode("123456"));
}

test.each(["sign-in", "sign-up"] as const)("%s: a verified email is exchanged for a real session before the person counts as signed in", async (mode) => {
  await withFlow(den({ signUp: mode === "sign-up" }), async ({ state, paths, submit }) => {
    await reachVerification(state, submit, mode);
    const beforeVerify = paths.length;

    expect(await submit()).toBe("join-org");

    expect(paths.slice(beforeVerify, beforeVerify + 2)).toEqual(["/api/auth/email-otp/verify-email", "/api/auth/sign-in/email"]);
    expect(state().user?.id).toBe(account.id);
  });
});

test("a verified email with no password to exchange stays on sign-in instead of a sessionless signed-in screen", async () => {
  await withFlow(den(), async ({ state, paths, submit }) => {
    await reachVerification(state, submit, "sign-in");
    await act(async () => state().setPassword(""));
    const beforeVerify = paths.length;

    expect(await submit()).toBeNull();

    expect(paths.slice(beforeVerify)).toEqual(["/api/auth/email-otp/verify-email", "/v1/me"]);
    expect(state().user).toBeNull();
    expect(state().authMode).toBe("sign-in");
    expect(state().verificationRequired).toBe(false);
    expect(state().authInfo).toBe(`Email verified. Sign in as ${account.email} to continue.`);
  });
});

test("the invite page asks a person whose session ended to sign in again instead of showing unauthorized", async () => {
  let sessionAlive = true;
  const preview = {
    invitation: { id: "invitation-1", email: account.email, role: "member", status: "pending" },
    organization: { id: "org-1", name: "Acme", slug: "acme", allowedEmailDomains: null },
  };
  const reply = (path: string): Reply => {
    if (path === "/v1/me") return sessionAlive ? { payload: { user: account } } : { status: 401, payload: { error: "unauthorized" } };
    if (path === "/v1/me/orgs") return { payload: { orgs: [] } };
    if (path.startsWith("/v1/orgs/invitations/preview")) return { payload: preview };
    if (path === "/v1/orgs/invitations/accept") {
      sessionAlive = false;
      return { status: 401, payload: { error: "unauthorized" } };
    }
    if (path.startsWith("/api/auth/login-options")) return { payload: { nextStep: "password" } };
    return { payload: {} };
  };

  await mount(reply, createElement(JoinOrgScreen, { invitationId: invitationToken }), async ({ container, paths }) => {
    await settle();
    const join = [...container.querySelectorAll("button")].find((button) => button.textContent === "Join Acme");
    if (!join) throw new Error(`Join button missing: ${container.textContent}`);

    await act(async () => { join.click(); });
    await settle();

    expect(paths).toContain("/v1/orgs/invitations/accept");
    expect(container.textContent).toContain("Your session ended. Sign in again to join.");
    expect(container.textContent).not.toContain("unauthorized");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Join Acme")).toBe(false);
  });
});
