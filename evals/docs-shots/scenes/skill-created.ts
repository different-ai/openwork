import { clickButton, evalIn, waitFor } from "@openwork/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp";
import type { App } from "@openwork/testkit/stack";
import type { Scene } from "../scene.ts";
import {
  CHAT_CLOSING_REPLY,
  CHAT_SKILL_NAME,
  WITNESS_MODEL_ID,
  WITNESS_PROVIDER_ID,
} from "../witness.ts";

const resourceUri = "ui://openwork/skill-created/v1/view.html";
const composerMessage = "Turn what we just did into a reusable skill for me";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForMountedSkillCard(app: App, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    const targets = await listTargets(app.handle.cdpUrl);
    const sandbox = targets.find((target) => target.type === "iframe"
      && target.url.includes("/mcp-apps/sandbox.html")
      && target.webSocketDebuggerUrl);
    if (sandbox) {
      const client = await connect(debuggerUrlFor(app.handle.cdpUrl, sandbox));
      try {
        const text = await evaluate(client, `document.querySelector("iframe")?.contentDocument?.body?.innerText ?? ""`);
        if (typeof text === "string") {
          lastText = text;
          const normalized = text.toLocaleLowerCase();
          if (normalized.includes("skill created") && normalized.includes(CHAT_SKILL_NAME)) return;
        }
      } finally {
        client.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The skill-created card did not mount with its content. Last iframe text:\n${lastText.slice(0, 600)}`);
}

export const skillCreatedCard: Scene = {
  id: "skill-created-card",
  title: "Chat: skill-created rich confirmation card (MCP App)",
  out: "packages/docs/images/skill-created-mcp-app-card.png",
  run: async (stage) => {
    const { den, mcpToken } = await stage.cloud();
    const app = await stage.desktop();

    const reconciled = await evalIn(app, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!port || !token) return "missing local server credentials";
      const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify("__WORKSPACE_ID__")}) + "/mcp/openwork-cloud/reconcile", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            type: "remote",
            url: ${JSON.stringify("__MCP_URL__")},
            enabled: true,
            headers: { Authorization: ${JSON.stringify("Bearer __MCP_TOKEN__")} },
            oauth: false,
          },
          provider: ${JSON.stringify(WITNESS_PROVIDER_ID)},
          model: ${JSON.stringify(WITNESS_MODEL_ID)},
          trigger: "docs-shots",
        }),
      });
      const text = await response.text();
      if (!response.ok) return "Cloud MCP reconcile failed: " + response.status + " " + text.slice(0, 1000);
      const health = JSON.parse(text);
      if (health?.phase !== "ready") return "Cloud MCP reconcile was not ready: " + JSON.stringify(health).slice(0, 1000);
      return "ok";
    })()`
      .replaceAll("__WORKSPACE_ID__", app.workspaceId)
      .replaceAll("__MCP_URL__", `${den.ref.apiUrl}/mcp/agent`)
      .replaceAll("__MCP_TOKEN__", mcpToken), { awaitPromise: true, timeoutMs: 90_000 });
    if (reconciled !== "ok") throw new Error(`Connecting the Cloud MCP failed: ${String(reconciled)}`);

    const task = await evalIn(app, `(async () => {
      const deadline = Date.now() + 60000;
      let last = null;
      while (Date.now() < deadline) {
        last = await window.__openworkControl.execute("session.create_task", null);
        if (last?.ok === true) return last;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return last;
    })()`, { awaitPromise: true, timeoutMs: 70_000 });
    if (!isRecord(task) || task.ok !== true) throw new Error(`Creating a task failed: ${JSON.stringify(task)}`);
    await waitFor(app, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
      timeoutMs: 30_000,
      label: "composer ready",
    });
    const focused = await evalIn(app, `(() => {
      const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      return true;
    })()`);
    if (focused !== true) throw new Error("Focusing the composer failed.");
    await app.client.send("Input.insertText", { text: composerMessage });
    await clickButton(app, "Run task", { timeoutMs: 30_000 });

    await waitFor(app, `document.body.innerText.includes(${JSON.stringify(CHAT_CLOSING_REPLY)})`, {
      timeoutMs: 180_000,
      label: "closing reply",
    });
    await waitFor(app, `Boolean(document.querySelector(${JSON.stringify(`[data-mcp-app-resource="${resourceUri}"] iframe`)}))`, {
      timeoutMs: 60_000,
      label: "skill-created MCP App frame",
    });
    await waitForMountedSkillCard(app, 60_000);
    await waitFor(app, `!document.body.innerText.includes("Pulling in the latest messages")`, {
      timeoutMs: 60_000,
      label: "session sync settled",
    });
    await evalIn(app, `document.querySelector('[data-mcp-app-resource="${resourceUri}"]')?.scrollIntoView({ block: "center" }); true`);
    return app;
  },
  gate: {
    requireText: [CHAT_CLOSING_REPLY],
    rejectText: [
      "Interactive view unavailable",
      "MCP_APP_RESOURCE_NOT_FOUND",
      "Pulling in the latest messages",
      "new notifications",
    ],
    requireExpression: `Boolean(document.querySelector('[data-mcp-app-resource="${resourceUri}"] iframe'))`,
  },
};
