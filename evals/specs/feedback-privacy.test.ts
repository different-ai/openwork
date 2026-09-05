import { createServer } from "node:net";
import { expect } from "vitest";
import { chrome } from "@openwork/hosts";
import { evaluateOnSurface, typeText } from "@openwork/cdp";
import { eventually, needs, test } from "@openwork/testkit";

test("feedback removes credentials before submission and email delivery", async ({ evidence }) => {
  needs({ env: ["OPENWORK_EVAL_LANDING_URL", "OPENWORK_EVAL_FEEDBACK_SMTP_PORT"] });
  const origin = process.env.OPENWORK_EVAL_LANDING_URL;
  const messages: string[] = [];
  const smtp = createServer((socket) => {
    socket.write("220 localhost synthetic witness\r\n");
    let buffer = "";
    let data = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        if (data) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          data = false;
          socket.write("250 accepted\r\n");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (line.startsWith("DATA")) { data = true; socket.write("354 send data\r\n"); }
        else if (line.startsWith("QUIT")) socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => smtp.listen(Number(process.env.OPENWORK_EVAL_FEEDBACK_SMTP_PORT), "127.0.0.1", resolve));
  try {
    await using browser = await chrome({ startUrl: `${origin}/feedback`, headless: true });
    await eventually(() => evaluateOnSurface(browser, 'Boolean(document.querySelector("textarea"))'), {
      within: 60_000, until: (ready) => ready === true,
    });
    await eventually(() => evaluateOnSurface(browser, 'document.readyState'), {
      within: 30_000, until: (state) => state === "complete",
    });
    // Allow client hydration and respect the real form's minimum submission age.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const [selector, value] of [
      ['input[autocomplete="name"]', "Synthetic Reporter"],
      ['input[type="email"]', "reporter@example.invalid"],
      ["textarea", "Connection failed Bearer synthetic-browser-secret sk-proj-synthetic-api-secret"],
    ]) {
      await evaluateOnSurface(browser, `document.querySelector(${JSON.stringify(selector)}).focus()`);
      await typeText(browser, value);
    }
    await evaluateOnSurface(browser, `(() => {
      const original = window.fetch;
      window.fetch = async (...args) => {
        if (String(args[0]).includes("/api/app-feedback")) window.__feedbackPayload = JSON.parse(args[1].body);
        return original(...args);
      };
    })()`);
    // Respect the real form's minimum submission age.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await evaluateOnSurface(browser, 'document.querySelector("form").requestSubmit()');
    const payload = await eventually(() => evaluateOnSurface(browser, "window.__feedbackPayload"), {
      within: 15_000, until: (value) => Boolean(value),
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("synthetic-browser-secret");
    expect(serialized).not.toContain("synthetic-api-secret");
    expect(serialized).toContain("Connection failed");
    expect(serialized).toContain("reporter@example.invalid");
    evidence.recordAssertionEvidence("Browser redacts pasted credentials before HTTP transmission", "Synthetic bearer and API credentials absent; failure context and intentional contact preserved", true);
    await eventually(() => messages.length, { within: 30_000, until: (count) => count === 1 });
    const response = await fetch(`${origin}/api/app-feedback`, {
      method: "POST",
      headers: { origin: String(origin), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Synthetic Reporter", email: "reporter@example.invalid", website: "",
        startedAt: Date.now() - 2000,
        message: 'Connection failed {"refresh_token":"synthetic-direct-secret"} Bearer synthetic-direct-bearer',
        context: { appVersion: "1.2.3", platform: "api_key=synthetic-context-secret" },
      }),
    });
    expect(response.status).toBe(200);
    await eventually(() => messages.length, { within: 30_000, until: (count) => count === 2 });
    const delivered = messages.join("\n");
    for (const secret of ["synthetic-browser-secret", "synthetic-api-secret", "synthetic-direct-secret", "synthetic-direct-bearer", "synthetic-context-secret"]) {
      expect(delivered).not.toContain(secret);
    }
    expect(delivered).toContain("Connection failed");
    expect(delivered).toContain("reporter@example.invalid");
    expect(delivered).toContain("1.2.3");
    evidence.recordAssertionEvidence("Email boundary redacts direct submissions and diagnostic context", "Two synthetic emails captured locally; secrets absent and useful context/contact retained", true);
  } finally {
    await new Promise<void>((resolve, reject) => smtp.close((error) => error ? reject(error) : resolve()));
  }
});
