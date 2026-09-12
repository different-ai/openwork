import { expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as navigation from "next/navigation";
import * as requests from "../app/(den)/_lib/den-flow";
import * as runtime from "../app/(den)/_lib/runtime-config";
import * as shell from "../app/(den)/_components/onboarding-shell";
import { PENDING_ORG_INVITATION_STORAGE_KEY } from "../app/(den)/_lib/den-org";
import { DenFlowProvider, useDenFlow } from "../app/(den)/_providers/den-flow-provider";
import VerifyPage from "../app/(den)/verify/page";

type Reply = { status: number; payload: unknown };
const email = "member@example.test";
const verified = { id: "user-test", name: "Member", email, emailVerified: true };

async function withAuth(input: { invite?: string; signup?: Reply; signin?: Reply; children?: ReactNode }, check: (fixture: {
  state: () => ReturnType<typeof useDenFlow>;
  container: HTMLDivElement;
  calls: { path: string; body: unknown }[];
  submit: () => Promise<void>;
}) => Promise<void>) {
  GlobalRegistrator.register({ url: "https://app.example.test/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const config = { ...runtime.EMPTY_RUNTIME_CONFIG, orgMode: "multi_org" } satisfies runtime.DenWebRuntimeConfig;
  spyOn(runtime, "getRuntimeConfig").mockResolvedValue(config);
  spyOn(navigation, "usePathname").mockReturnValue(input.children ? "/verify" : "/join-org");
  spyOn(navigation, "useRouter").mockReturnValue({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch: async () => {} });
  spyOn(shell, "OnboardingShell").mockImplementation(({ children }) => <div>{children}</div>);
  const calls: { path: string; body: unknown }[] = [];
  let signedIn = false;
  spyOn(requests, "requestJson").mockImplementation(async (path, init) => {
    calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const reply = path.startsWith("/api/auth/sign-up/email") ? input.signup ?? { status: 200, payload: { token: null, user: verified } }
      : path === "/api/auth/sign-in/email" ? input.signin ?? { status: 200, payload: { token: "session-token", user: verified } }
      : path.startsWith("/api/auth/sso-resolve") ? { status: 200, payload: { method: "password" } }
      : path === "/v1/me" && signedIn ? { status: 200, payload: { user: verified } }
      : { status: 401, payload: {} };
    if (path === "/api/auth/sign-in/email" && reply.status === 200) signedIn = true;
    return { response: Response.json(reply.payload, { status: reply.status }), payload: reply.payload, text: JSON.stringify(reply.payload) };
  });
  if (input.invite) window.sessionStorage.setItem(PENDING_ORG_INVITATION_STORAGE_KEY, input.invite);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current: ReturnType<typeof useDenFlow> | null = null;
  function Capture() {
    current = useDenFlow();
    return <form data-auth-form onSubmit={current.submitAuth} />;
  }
  try {
    await act(async () => root.render(<DenFlowProvider><Capture />{input.children}</DenFlowProvider>));
    const state = () => { if (!current) throw new Error("Auth not mounted"); return current; };
    if (!input.children) {
      await act(async () => { state().setEmail(email); state().setPassword("StrongPassword1!"); });
    }
    await check({ state, container, calls, submit: async () => {
      await act(async () => { container.querySelector("[data-auth-form]")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    } });
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    await GlobalRegistrator.unregister();
  }
}

test("tokenless invited signup attempts password sign-in with the raw invite in the signup query", async () => {
  await withAuth({ invite: "raw-token" }, async ({ submit, state, calls }) => {
    await submit();
    expect(calls.some(({ path }) => path === "/api/auth/sign-up/email?invite=raw-token")).toBe(true);
    expect(calls.filter(({ path }) => path === "/api/auth/sign-in/email")).toHaveLength(1);
    expect(state().verificationRequired).toBe(false);
    expect(window.localStorage.getItem(requests.AUTH_TOKEN_STORAGE_KEY)).toBe("session-token");
    expect(calls.some(({ path }) => path.includes("invitations/accept"))).toBe(false);
  });
});

test.each(["signup", "signin"])("generic %s 403 stays on auth instead of OTP", async (failure) => {
  const denied = { status: 403, payload: { code: "ACCESS_DENIED", message: "Blocked by policy." } };
  await withAuth({ invite: "raw-token", ...(failure === "signup" ? { signup: denied } : { signin: denied }) }, async ({ submit, state }) => {
    await submit();
    expect(state().verificationRequired).toBe(false);
    expect(state().authError).toBe("Blocked by policy.");
  });
});

test("unproven invite opens real OTP only after sign-in reports EMAIL_NOT_VERIFIED", async () => {
  await withAuth({ invite: "stale-token", signin: { status: 403, payload: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" } } }, async ({ submit, state }) => {
    await submit();
    expect(state().verificationRequired).toBe(true);
    expect(state().user).toBeNull();
    expect(window.localStorage.getItem(requests.AUTH_TOKEN_STORAGE_KEY)).toBeNull();
  });
});

test("ordinary tokenless signup opens verification without password sign-in", async () => {
  await withAuth({}, async ({ submit, state, calls }) => {
    await submit();
    expect(state().verificationRequired).toBe(true);
    expect(calls.some(({ path }) => path === "/api/auth/sign-in/email")).toBe(false);
  });
});

test("recovery page restores locked code entry without verifying, signing in, or sending a code", async () => {
  const page = await VerifyPage({ searchParams: Promise.resolve({ email: " Member@Example.Test " }) });
  await withAuth({ children: page }, async ({ state, container, calls }) => {
    expect(state().verificationRequired).toBe(true);
    expect(state().email).toBe(email);
    expect(container.textContent).toContain("Verification code");
    expect(container.textContent).toContain(email);
    expect(container.textContent).not.toContain("Change email");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(state().user).toBeNull();
    expect(calls.some(({ path }) => path.startsWith("/api/auth/"))).toBe(false);
  });
});
