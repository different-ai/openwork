import { z } from "zod";
import { registerCloudSkillDiscovery, type CloudSkillContext } from "./openwork-cloud-skills-v2.js";
import { server as browserTools } from "./openwork-chrome-devtools.js";
import { server as computerTools } from "./openwork-computer-use.js";
import { DRIVE_FILE_TOOLS } from "./drive-file-tools.js";
import { addProviderSafeTool } from "./provider-safe-tool-schema.js";

const browserResult = z.object({
  content: z.array(z.union([z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("file"), uri: z.string(), mime: z.string() })])),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type ToolCall = { signal: AbortSignal; sessionID: string; messageID?: string; id?: string; agent?: string };
type Tool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute(input: unknown, context: ToolCall): Promise<z.infer<typeof browserResult>>;
};
type Context = CloudSkillContext & {
  location?: { directory?: string };
  options: { url: string; token: string; browser?: { url: string; token: string } };
  tool: {
    transform(callback: (editor: { add(tool: Tool): void }) => void): Promise<{ dispose(): Promise<void> }>;
    reload?(): Promise<void>;
  };
};

// Separate credentials authorize app reads, sidebar group changes, inert
// automation proposals, Drive file transfers and Gmail or Outlook drafts the
// person approves, and conversation-scoped browser and computer operations.
// Neither grants arbitrary host APIs or other OpenWork app commands.
export default {
  id: "openwork.context",
  async setup(context: Context) {
    // The host asks the person in this tool call's chat before a Drive change or a Gmail or Outlook draft.
    const driveCall = async (name: string, input: unknown, call: ToolCall, failure: string) => {
      const response = await fetch(context.options.url, {
        method: "POST", redirect: "error", signal: call.signal,
        headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, input, sessionId: call.sessionID, ...(context.location?.directory && call.messageID && call.id ? {
          caller: { directory: context.location.directory, messageId: call.messageID, callId: call.id, ...(call.agent ? { agent: call.agent } : {}) },
        } : {}) }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${failure}: ${text}`);
      return { content: [{ type: "text" as const, text }] };
    };
    const browser = context.options.browser;
    const browserDefinitions = browser ? (await browserTools()).tool : undefined;
    const computerDefinitions = browser ? (await computerTools()).tool : undefined;
    // Browser and computer tools share one bridge but are offered separately.
    // Everything the model reads about a capability (tool descriptions and the
    // rules folded into them) arrives only with that capability's tools, so a
    // prompt never describes something this chat cannot use. Keep it that way:
    // browser text must not point at computer_* tools, and new instructions
    // that mention a gated capability belong in that capability's tools.
    // Computer tools follow the desktop's `computerUse` feature, checked again
    // before each prompt. Without a prompt hook and registry reload the choice
    // could not change later, so they stay offered.
    const gated = typeof context.tool.reload === "function" && context.session !== undefined;
    const computerOffered = async (current: boolean) => {
      if (!browser || !gated) return true;
      try {
        const response = await fetch(new URL("/computer", browser.url), {
          redirect: "error", signal: AbortSignal.timeout(5_000), headers: { Authorization: `Bearer ${browser.token}` },
        });
        const body: unknown = response.ok ? await response.json() : undefined;
        return body && typeof body === "object" && "offered" in body && typeof body.offered === "boolean" ? body.offered : current;
      } catch {
        return current;
      }
    };
    let computerOn = await computerOffered(true);
    const registration = await context.tool.transform(editor => {
      for (const name of ["openwork_context", "openwork_query", "openwork_execute"]) {
        addProviderSafeTool(editor, {
          name,
          description: name === "openwork_context"
            ? "Read OpenWork app context and available affordances. Use this to discover session.search and session.read for other conversations, session.group commands for sidebar groups, session.create and session.send to start or message other sessions, session.question.list and session.question.answer for questions another session is waiting on, and automation.propose for scheduled work."
            : name === "openwork_query"
              ? "Read an OpenWork affordance without changing the app or navigating. Use the exact id and arguments from openwork_context; session.read includes live background-agent activity."
              : "Run an OpenWork command listed in openwork_context: change sidebar groups, create or message sessions, answer another session's pending question with the person's answers, or propose an Automation for the person to review and create. A proposal does not create, activate, or run anything. Use the exact id and arguments from openwork_context.",
          input: name === "openwork_context" ? { type: "object", properties: {}, additionalProperties: false } : {
            type: "object", properties: { id: { type: "string" }, args: { type: "object", additionalProperties: true } },
            required: ["id"], additionalProperties: false,
          },
          options: { codemode: true },
          async execute(input, call) {
            call.signal.throwIfAborted();
            const response = await fetch(context.options.url, {
              method: "POST", redirect: "error", signal: call.signal,
              headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                name, input, sessionId: call.sessionID,
                // A command that asks first shows its approval at this call in the chat.
                ...(name === "openwork_execute" && context.location?.directory && call.messageID && call.id ? {
                  caller: { directory: context.location.directory, messageId: call.messageID, callId: call.id, ...(call.agent ? { agent: call.agent } : {}) },
                } : {}),
              }),
            });
            if (!response.ok) throw new Error(`OpenWork ${name === "openwork_execute" ? "command" : "read"} failed (${response.status})`);
            return { content: [{ type: "text", text: await response.text() }] };
          },
        });
      }
      addProviderSafeTool(editor, {
        name: "openwork_drive_upload",
        description: "Upload one workspace file to the member's Google Drive through OpenWork Cloud, outside model context. Use this when the user asks to put a local file in Drive; it does not need a separate Google sign-in. Bytes, basename and MIME type are preserved without Office conversion. path is workspace-relative or an absolute path under an authorized workspace root. folderId selects a Drive parent folder; connectionId (google-workspace or emc_...) selects a Google account and never falls back to another. The person approves each upload in the chat first; if they decline, do not upload it another way. Returns the Drive file id. Never retry an unconfirmed upload automatically.",
        input: { type: "object", properties: {
          path: { type: "string" }, folderId: { type: "string" }, connectionId: { type: "string", pattern: "^(google-workspace|emc_[A-Za-z0-9]+)$" },
        }, required: ["path"], additionalProperties: false },
        options: { codemode: false },
        execute: (input, call) => driveCall("openwork_drive_upload", input, call, "Drive upload failed"),
      });
      addProviderSafeTool(editor, {
        name: "openwork_gmail_draft",
        description: "Create a Gmail draft, or a reply on a Gmail thread, with workspace files attached through OpenWork Cloud, outside model context. Use this when the user asks to email or reply with local files from Gmail. to, cc and bcc are comma-separated addresses; a reply passes the thread's threadId and keeps its subject. Up to ten files, 4 MiB in all; paths are workspace-relative or absolute under an authorized workspace root. connectionId (google-workspace or emc_...) selects a Google account. The person approves each draft in the chat first, and it is never sent. Never retry an unconfirmed draft automatically.",
        input: { type: "object", properties: {
          to: { type: "string" }, cc: { type: "string" }, bcc: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, threadId: { type: "string" },
          connectionId: { type: "string", pattern: "^(google-workspace|emc_[A-Za-z0-9]+)$" },
          paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
        }, required: ["to", "subject", "body", "paths"], additionalProperties: false },
        options: { codemode: false },
        execute: (input, call) => driveCall("openwork_gmail_draft", input, call, "Gmail draft failed"),
      });
      addProviderSafeTool(editor, {
        name: "openwork_outlook_draft",
        description: "Create an Outlook draft, or a reply draft to one Outlook message, with workspace files attached through OpenWork Cloud, outside model context. Use this when the user asks to email or reply with local files from Outlook. A new draft needs to and subject; a reply takes replyToMessageId and body only, keeping the message's recipients and subject. body is plain text unless bodyContentType is html; use html for links, line breaks, tables or a signature. Up to ten files, each under 3 MB and 4 MiB in all; paths are workspace-relative or absolute under an authorized workspace root. connectionId (microsoft-365 or emc_...) selects a Microsoft account. The person approves each draft in the chat first, and it is never sent. Never retry an unconfirmed draft automatically.",
        input: { type: "object", properties: {
          to: { type: "array", items: { type: "string" } }, cc: { type: "array", items: { type: "string" } }, bcc: { type: "array", items: { type: "string" } },
          subject: { type: "string" }, body: { type: "string" }, bodyContentType: { type: "string", enum: ["text", "html"] }, replyToMessageId: { type: "string" },
          connectionId: { type: "string", pattern: "^(microsoft-365|emc_[A-Za-z0-9]+)$" },
          paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
        }, required: ["body", "paths"], additionalProperties: false },
        options: { codemode: false },
        execute: (input, call) => driveCall("openwork_outlook_draft", input, call, "Outlook draft failed"),
      });
      for (const [name, tool] of Object.entries(DRIVE_FILE_TOOLS)) {
        addProviderSafeTool(editor, {
          name, description: tool.description, input: z.toJSONSchema(tool.args),
          options: { codemode: false },
          execute: (input, call) => driveCall(name, input, call, `${name} failed`),
        });
      }
      const bridged = { ...browserDefinitions, ...(computerOn ? computerDefinitions : undefined) };
      if (browser) for (const [name, definition] of Object.entries(bridged)) {
        addProviderSafeTool(editor, {
          name, description: definition.description,
          input: z.toJSONSchema(z.object(definition.args)),
          options: { codemode: false },
          async execute(input, call) {
            const response = await fetch(browser.url, {
              method: "POST", redirect: "error", signal: call.signal,
              headers: { Authorization: `Bearer ${browser.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ name, input, sessionId: call.sessionID }),
            });
            if (!response.ok) throw new Error(`${name.startsWith("computer_") ? "Computer" : "Browser"} request failed (${response.status})`);
            return browserResult.parse(await response.json());
          },
        });
      }
    });
    const promptHook = browser && gated && context.session ? await context.session.hook("prompt", async () => {
      const next = await computerOffered(computerOn);
      if (next === computerOn) return;
      computerOn = next;
      await context.tool.reload?.();
    }) : undefined;
    const stopSkills = await registerCloudSkillDiscovery(context);
    return async () => { await stopSkills(); await promptHook?.dispose(); await registration.dispose(); };
  },
};
