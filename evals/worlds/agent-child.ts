import { resolveEvalEngine, type Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { splitPaneQuestions } from "./chat.ts";

async function childConversation(seed: Seed, surface: "web" | "electron") {
  const engine = resolveEvalEngine();
  const tool = engine === "v2" ? "subagent" : "task";
  const prompt = "Delegate reviewing the fixture to a helper and report its findings.";
  const childPrompt = "Review the fixture. Delegate checking its output before answering.";
  const grandchildPrompt = "Check the fixture output and report the version.";
  const followup = "Include the fixture version in your answer.";
  const finalReply = "The fixture review includes version 3.";
  const delegate = (description: string, prompt: string) => ({ tool, arguments: {
    description, prompt, ...(engine === "v2" ? { agent: "general", background: false } : { subagent_type: "general" }),
  } });
  const base = await splitPaneQuestions(seed, "child-conversation", [
    { promptMarker: prompt, latestUserTurn: true, finalReply: "The delegated fixture review is ready.", steps: [delegate("Review fixture", childPrompt)] },
    { promptMarker: childPrompt, latestUserTurn: true, finalReply: finalReply, steps: [delegate("Check fixture output", grandchildPrompt)] },
    { promptMarker: grandchildPrompt, latestUserTurn: true, steps: [], finalReply: "Checking the fixture. The fixture output is version 3.",
      finalReplyChunks: ["Checking the fixture. ", "The fixture output is version 3."], finalReplyInitiallyReleasedChunks: 1 },
    { promptMarker: followup, latestUserTurn: true, steps: [], finalReply },
  ], { ...(engine === "v1" ? { model: "split-send-mock/split-send-model" } : {}), ...(engine === "v2" ? { experimental: { subagent_depth: 2 } } : { subagent_depth: 2 }), permission: { task: "allow", question: "allow" }, agent: { general: { tools: { task: true }, permission: { task: "allow" } } } }, surface, { createWorkspace: surface === "electron" });
  const session = await seed.session(base.app, { title: "Fixture review" });
  return { ...base, session, engine, prompt, childPrompt, grandchildPrompt, followup, finalReply,
    selectedSessionId: () => seed.evalIn(base.app, () => document.querySelector('[data-workbench-pane-focused="true"] [data-session-surface-id]')?.getAttribute("data-session-surface-id") ?? ""),
    nativeSession: (sessionId: string) => seed.evalIn(base.app, browserScript(async (workspaceId, engine, sessionId) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/workspace/" + encodeURIComponent(workspaceId)
        + (engine === "v2" ? "/opencode2/api" : "/opencode");
      const response = await fetch(base + "/session/" + encodeURIComponent(sessionId), {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
      });
      if (!response.ok) throw new Error("Native session ownership: " + response.status);
      const body: unknown = await response.json();
      return body;
    }, [base.workspace.workspaceId, engine, sessionId]), { awaitPromise: true }),
    delegatedTools: () => seed.evalIn(base.app, browserScript(async (workspaceId, engine) => {
      const sessionId = document.querySelector('[data-workbench-pane-focused="true"] [data-session-surface-id]')?.getAttribute("data-session-surface-id");
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/workspace/" + encodeURIComponent(workspaceId)
        + (engine === "v2" ? "/opencode2/api" : "/opencode");
      const response = await fetch(base + "/session/" + encodeURIComponent(sessionId ?? "") + "/message?limit=50", {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
      });
      if (!response.ok) throw new Error("Native child history: " + response.status);
      const raw = await response.json();
      return (Array.isArray(raw) ? raw : raw.data ?? []).flatMap((message: { parts?: { type: string; tool?: string; state?: unknown }[]; content?: { type: string; name?: string; state?: unknown }[] }) =>
        (message.parts ?? message.content ?? []).filter(part => part.type === "tool").map(part => ({ tool: "tool" in part ? part.tool : "name" in part ? part.name : undefined, state: part.state })));
    }, [base.workspace.workspaceId, engine]), { awaitPromise: true }),
    grandchildState: () => base.mock.agentReplyState(grandchildPrompt),
    releaseGrandchild: () => base.mock.releaseAgentReply(grandchildPrompt),
  };
}

export const agentChildWeb = (seed: Seed) => childConversation(seed, "web");
export const agentChildDesktop = (seed: Seed) => childConversation(seed, "electron");
