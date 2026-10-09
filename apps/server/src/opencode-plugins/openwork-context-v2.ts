import { z } from "zod";
import { registerCloudSkillDiscovery, type CloudSkillContext } from "./openwork-cloud-skills-v2.js";
import { server as browserTools } from "./openwork-chrome-devtools.js";

const browserResult = z.object({
  content: z.array(z.union([z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("file"), uri: z.string(), mime: z.string() })])),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type Tool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute(input: unknown, context: { signal: AbortSignal; sessionID: string }): Promise<z.infer<typeof browserResult>>;
};
type Context = CloudSkillContext & {
  options: { url: string; token: string; browser?: { url: string; token: string } };
  tool: { transform(callback: (editor: { add(tool: Tool): void }) => void): Promise<{ dispose(): Promise<void> }> };
};

// Separate credentials authorize app reads plus one Drive file upload, and
// conversation-scoped browser operations. Neither grants arbitrary host APIs
// or OpenWork app commands.
export default {
  id: "openwork.context",
  async setup(context: Context) {
    const browser = context.options.browser;
    const browserDefinitions = browser ? await browserTools() : undefined;
    const registration = await context.tool.transform(editor => {
      for (const name of ["openwork_context", "openwork_query"]) {
        editor.add({
          name,
          description: name === "openwork_context"
            ? "Read OpenWork app context and available read-only affordances. Use this to discover session.search and session.read for other conversations."
            : "Read an OpenWork affordance without changing the app or navigating. Use the exact id and arguments from openwork_context; session.read includes live background-agent activity.",
          input: name === "openwork_context" ? { type: "object", properties: {}, additionalProperties: false } : {
            type: "object", properties: { id: { type: "string" }, args: { type: "object", additionalProperties: true } },
            required: ["id"], additionalProperties: false,
          },
          options: { codemode: false },
          async execute(input, call) {
            const response = await fetch(context.options.url, {
              method: "POST", redirect: "error", signal: call.signal,
              headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ name, input }),
            });
            if (!response.ok) throw new Error(`OpenWork read failed (${response.status})`);
            return { content: [{ type: "text", text: await response.text() }] };
          },
        });
      }
      editor.add({
        name: "openwork_drive_upload",
        description: "Upload one workspace file to the member's Google Drive through OpenWork Cloud, outside model context. Use this when the user asks to put a local file in Drive; it does not need a separate Google sign-in. Bytes, basename and MIME type are preserved without Office conversion. path is workspace-relative or an absolute path under an authorized workspace root. folderId selects a Drive parent folder; connectionId (google-workspace or emc_...) selects a Google account and never falls back to another. Returns the Drive file id. Never retry an unconfirmed upload automatically.",
        input: { type: "object", properties: {
          path: { type: "string" }, folderId: { type: "string" }, connectionId: { type: "string", pattern: "^(google-workspace|emc_[A-Za-z0-9]+)$" },
        }, required: ["path"], additionalProperties: false },
        options: { codemode: false },
        async execute(input, call) {
          const response = await fetch(context.options.url, {
            method: "POST", redirect: "error", signal: call.signal,
            headers: { Authorization: `Bearer ${context.options.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "openwork_drive_upload", input }),
          });
          const text = await response.text();
          if (!response.ok) throw new Error(`Drive upload failed: ${text}`);
          return { content: [{ type: "text", text }] };
        },
      });
      if (browser && browserDefinitions) for (const [name, definition] of Object.entries(browserDefinitions.tool)) {
        editor.add({
          name, description: definition.description,
          input: z.toJSONSchema(z.object(definition.args)),
          options: { codemode: false },
          async execute(input, call) {
            const response = await fetch(browser.url, {
              method: "POST", redirect: "error", signal: call.signal,
              headers: { Authorization: `Bearer ${browser.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ name, input, sessionId: call.sessionID }),
            });
            if (!response.ok) throw new Error(`Browser request failed (${response.status})`);
            return browserResult.parse(await response.json());
          },
        });
      }
    });
    const stopSkills = await registerCloudSkillDiscovery(context);
    return async () => { await stopSkills(); await registration.dispose(); };
  },
};
