import { z } from "zod";
import { coerceJsonValue } from "./browser-tool-args.js";

export const USE_PRIVATE_VALUES = "use_private_values";

export type PrivateValuesAsk = (path: "state" | "use", body: unknown, signal?: AbortSignal) => Promise<unknown>;
export type PrivateValuesCall = { sessionId: string; directory?: string; signal?: AbortSignal };

const valueName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).describe("An UPPER_CASE name. A program gets the value in this environment variable; a request takes it wherever {{NAME}} is written.");
const usedValue = z.object({
  name: valueName,
  command: z.array(z.string().max(512)).min(1).max(16).optional().describe("A program and its arguments that print the value alone, such as [\"op\", \"read\", \"op://Private/Deploy/token\"]. Started directly, with no shell. Give command or ask, never both."),
  ask: z.string().min(1).max(80).optional().describe("A short name for a value the person pastes themselves, such as \"Deploy token\". Give command or ask, never both."),
  unlock: z.object({ env: z.string().min(1).max(64), ask: z.string().min(1).max(80) }).optional().describe("A key the command needs in its environment, such as a password manager's session key, that the person pastes."),
  as: z.enum(["env", "file"]).optional().describe("For run only: env (default) puts the value in the variable; file writes it to a private temporary file, deleted afterwards, and puts that file's path in the variable."),
}).strict();

export const usePrivateValuesArgs = {
  values: z.array(usedValue).min(1).max(6),
  run: z.object({ command: z.array(z.string().max(512)).min(1).max(16).describe("The program, by name or absolute path, and its arguments, started directly with no shell. Values are never written into the arguments.") }).optional(),
  request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), url: z.string().url().max(2000).describe("An https URL, without any value in it."),
    headers: z.record(z.string(), z.string().max(2000)).optional(), body: z.string().max(16384).optional(),
    seal: z.array(z.object({
      name: valueName.describe("A NAME in capitals to keep it under."),
      from: z.string().max(400).describe("Dotted path of the string in the JSON answer, such as access_token or data.token."),
      for: z.string().url().optional().describe("The one https origin it may be sent to later. Defaults to this request's origin."),
    })).min(1).max(4).optional().describe("Secrets in the answer to keep for this chat instead of showing you."),
  }).optional().describe("One https request. Give run or request, never both."),
};

export const usePrivateValuesDescription = "Give private values (tokens, passwords, keys, account numbers) to one program or one https request without seeing them. Decide on your own which values are private: anything the person would not want you to read. Each value comes from a command that prints it, such as a password manager's CLI, or from the person pasting it on a card. The person approves every use on a card that shows the exact command or request. Use this whenever a program or API needs a value you should not read: never print, cat or echo such a value in a terminal, and never ask for it in chat. With run, the program gets each value in the named environment variable, or a private file whose path is there, in the workspace folder. With request, write {{NAME}} where each value goes in a header or the body, never in the URL; redirects are not followed. You get back what the program printed or the response, with every value replaced by [secret]. A command's value is fetched again each time. A value the person pastes can be kept for this chat when they choose that on the card: ask for it under the same NAME, for the same program or site, and they have nothing to paste again. When several steps need the same value, do them in one program so the person approves once. The card is the person's whole answer: never ask in chat whether they pasted or approved it. When a request's JSON answer holds a new secret, such as an access token from a token endpoint, list it in request.seal: it is kept for this chat, never shown to you, and you send it later with a value { name, ask: <the sealed name> } in a request to its for origin.";

const schema = z.object(usePrivateValuesArgs);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UNAVAILABLE = { ok: false, code: "values_unavailable", retrySafe: true, error: "Private values need the OpenWork desktop app open on the same computer as this task. Nothing was run or sent." };
const INTERRUPTED = { ok: false, code: "values_interrupted", retrySafe: false, error: "The connection to OpenWork was interrupted. A program may or may not have run and a request may or may not have been sent; check before trying again." };

export async function privateValueToolOn(ask: PrivateValuesAsk): Promise<boolean> {
  const reply = await ask("state", { check: true }).catch(() => null);
  return record(reply) && reply.ok === true && reply.enabled === true;
}

export async function usePrivateValues(raw: unknown, call: PrivateValuesCall, ask: PrivateValuesAsk): Promise<string> {
  const given = record(raw) ? { ...raw, values: coerceJsonValue(raw.values), run: coerceJsonValue(raw.run), request: coerceJsonValue(raw.request) } : raw;
  const args = schema.parse(given);
  let result: unknown;
  try {
    result = await ask("use", { sessionId: call.sessionId, args: { ...args, ...(call.directory ? { cwd: call.directory } : {}) } }, call.signal);
  } catch {
    return JSON.stringify(INTERRUPTED);
  }
  const code = record(result) ? result.code : undefined;
  if (code === "browser_unavailable") return JSON.stringify(UNAVAILABLE);
  if (code === "browser_disconnected" || !record(result)) return JSON.stringify(INTERRUPTED);
  return JSON.stringify(result);
}
