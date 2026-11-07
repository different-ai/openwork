import type { Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Password credentials are real; absent OAuth credentials keep this journey off external providers. */
export async function passwordSocialSignIn(seed: Seed) {
  const person = { email: "password-member@example.test", name: "Password member", password: "PasswordSignIn123!" };
  const den = await seed.den({
    org: { name: "Sign-in workspace", admin: person, members: {} },
    env: {
      GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "",
    },
  });
  const web = await seed.web({ den, headless: true, startPath: "/", viewport: { width: 1440, height: 1100 } });
  if (!web.client.webSocketDebuggerUrl) throw new Error("Social sign-in witness requires browser CDP");
  const socket = new WebSocket(web.client.webSocketDebuggerUrl);
  const socialRequests: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Social sign-in witness timed out")), 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Network.enable" })), { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Social sign-in witness could not connect")); }, { once: true });
    socket.addEventListener("message", (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (!isRecord(message)) return;
      if (message.id === 1) {
        clearTimeout(timer);
        if (message.error) reject(new Error("Social sign-in witness could not enable Network"));
        else resolve();
      }
      if (message.method !== "Network.requestWillBeSent" || !isRecord(message.params) || !isRecord(message.params.request)) return;
      const request = message.params.request;
      if (request.method !== "POST" || typeof request.url !== "string" || new URL(request.url).pathname !== "/api/auth/sign-in/social" || typeof request.postData !== "string") return;
      const body: unknown = JSON.parse(request.postData);
      if (isRecord(body)) socialRequests.push(body);
    });
  });
  return { den, web, person, socialRequests, async [Symbol.asyncDispose]() { socket.close(); } };
}
