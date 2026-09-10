import type { Seed } from "@openwork/env";
import { signupWorkspace } from "../../evals/worlds/signup-workspace.ts";

export async function onboardingWorld(seed: Seed) {
  const directory =
    process.env.OPENWORK_EVAL_FILM_DIR || seed.tmpPath("onboarding-film");
  const world = await signupWorkspace(seed, {
    filmDirectory: directory,
    viewport: { width: 1600, height: 940 },
  });
  world.owner.name = "Alex";
  world.owner.email = "alex@openwork.test";
  world.owner.password = "OpenWork-demo-9274!";
  return { ...world, directory };
}

export async function desktopOnboardingWorld(seed: Seed) {
  const world = await signupWorkspace(seed);
  const endpoint = world.web.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Desktop return witness requires browser CDP");
  const socket = new WebSocket(endpoint);
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let failure: Error | null = null;
  let disposed = false;
  const requests: { method: string; path: string }[] = [];
  const returns: string[] = [];
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  const fail = () => {
    if (disposed) return;
    failure = new Error("Desktop return witness lost browser CDP");
    rejectReady(failure);
  };
  const timeout = setTimeout(() => rejectReady(new Error("Desktop return witness timed out")), 15_000);
  socket.addEventListener("error", fail);
  socket.addEventListener("close", fail);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
    socket.send(JSON.stringify({ id: 2, method: "Page.enable" }));
  });
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (!record(message)) return;
    if (message.error) { fail(); return; }
    if (message.id === 2) resolveReady();
    if (!record(message.params)) return;
    const params = message.params;
    if (message.method === "Network.requestWillBeSent" && record(params.request)) {
      const request = params.request;
      if (typeof request.url === "string" && typeof request.method === "string") {
        const url = new URL(request.url);
        if (url.origin === new URL(world.den.ref.webUrl).origin) requests.push({ method: request.method, path: url.pathname });
      }
    }
    if (message.method === "Page.frameRequestedNavigation" && typeof params.url === "string" && params.url.startsWith("openwork://")) {
      // Mock only OS dispatch: retain the browser-issued URL, never mint a test grant.
      returns.push(params.url);
      socket.send(JSON.stringify({ id: 3, method: "Page.stopLoading" }));
    }
  });
  try {
    await ready;
  } catch (error) {
    disposed = true;
    socket.close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return {
    ...world,
    handoff() {
      if (failure) throw failure;
      return {
        grants: requests.filter(({ method, path }) => method === "POST" && path.endsWith("/auth/desktop-handoff")).length,
        modelWrites: requests.filter(({ method, path }) => method !== "GET" && /\/v1\/inference(?:\/|$)/.test(path)).length,
        returns: [...returns],
      };
    },
    async [Symbol.asyncDispose]() {
      disposed = true;
      socket.close();
      await world[Symbol.asyncDispose]();
    },
  };
}
