import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { agentUiContext, MOCK_REPLY } from "../worlds/agent-ui-context.ts";

const test = spec.world(agentUiContext, { needs: { commands: ["bun"] }, timeout: 240_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdOf(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error(`Expected a created session: ${JSON.stringify(value)}`);
  }
  return value.id;
}

function replyText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.parts)) return "";
  return value.parts
    .filter(isRecord)
    .filter((part) => part.type === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

function completedContextOutput(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const message of value) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool" || part.tool !== "openwork_context" || !isRecord(part.state)) continue;
      if (part.state.status === "completed" && typeof part.state.output === "string") return part.state.output;
    }
  }
  return null;
}

function parseOutput(output: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) throw new Error(`Expected object tool output: ${output}`);
  return parsed;
}

test("the in-app agent reads renderer context through openwork-server and gets an explicit result without a window", async ({ world, probe, step, evidence }) => {
  await step("without a connected window the tool reports that no OpenWork window is connected and the turn completes", async () => {
    const sessionId = sessionIdOf(await world.engine("POST", "/session", { title: "agent context without window" }));
    const result = await world.engine("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
      model: { providerID: "mock", modelID: "mock" },
      parts: [{ type: "text", text: "What is on my screen?" }],
    });
    const output = await probe.eventually(
      async () => completedContextOutput(await world.engine("GET", `/session/${encodeURIComponent(sessionId)}/message`)),
      {
        within: 30_000,
        label: "completed openwork_context tool without a window",
        until: (value) => value !== null,
      },
    );
    if (output === null) throw new Error("openwork_context did not complete");
    const parsed = parseOutput(output);
    const ui = isRecord(parsed.ui) ? parsed.ui : null;
    const error = ui && typeof ui.error === "string" ? ui.error : "";

    expect(parsed.context).toBeNull();
    expect(ui?.ok).toBe(false);
    expect(error).toContain("No OpenWork window is connected");
    expect(error).not.toContain("desktop app may not be running");
    expect(replyText(result)).toBe(MOCK_REPLY);
    evidence.recordAssertionEvidence(
      "Without a polling OpenWork window, the agent receives the server's explicit no-window result and still completes its turn",
      `openwork_context returned context=null and ui.error=${JSON.stringify(error)}; the model's reply was ${JSON.stringify(replyText(result))}.`,
      true,
    );
  });

  await step("a connected window's split layout reaches both the tool transcript and the model", async () => {
    const fakeWindow = await world.attachWindow({
      screen: "session",
      conversations: {
        layout: {
          kind: "split",
          focused: "secondary",
          primarySessionId: "ses_left",
          secondarySessionId: "ses_right",
        },
      },
      availableAffordances: [],
    });
    try {
      const sessionId = sessionIdOf(await world.engine("POST", "/session", { title: "agent context with window" }));
      const before = world.requests.length;
      const result = await world.engine("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
        model: { providerID: "mock", modelID: "mock" },
        parts: [{ type: "text", text: "What is on my screen?" }],
      });
      const output = await probe.eventually(
        async () => completedContextOutput(await world.engine("GET", `/session/${encodeURIComponent(sessionId)}/message`)),
        {
          within: 30_000,
          label: "completed openwork_context tool with a connected window",
          until: (value) => value !== null,
        },
      );
      if (output === null) throw new Error("openwork_context did not complete");
      const parsed = parseOutput(output);
      const context = isRecord(parsed.context) ? parsed.context : null;
      const conversations = context && isRecord(context.conversations) ? context.conversations : null;
      const layout = conversations && isRecord(conversations.layout) ? conversations.layout : null;
      const providerRequests = world.requests.slice(before);

      expect(layout?.secondarySessionId).toBe("ses_right");
      expect(Array.isArray(context?.availableAffordances)).toBe(true);
      expect(fakeWindow.handled).toHaveLength(1);
      expect(fakeWindow.handled[0]?.kind).toBe("context");
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]?.toolResults.some((content) => content.includes("ses_right"))).toBe(true);
      expect(replyText(result)).toBe(MOCK_REPLY);
      evidence.recordAssertionEvidence(
        "A renderer window's split layout crosses openwork-server into the agent tool result and the model's follow-up request",
        `The fake window handled one context request; the transcript and provider tool result both contained secondarySessionId=ses_right, and the turn replied ${JSON.stringify(replyText(result))}.`,
        true,
      );
    } finally {
      await fakeWindow.detach();
    }
  });
});
