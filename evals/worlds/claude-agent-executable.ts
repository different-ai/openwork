import { chmod, writeFile } from "node:fs/promises";

/** A credential-free Agent SDK subprocess. It only answers local discovery;
 * login, logout and inference are deliberately unsupported and audited. */
export async function writeClaudeAgentExecutable(path: string, auditPath: string, tokenSource: "none" | "oauth") {
  const source = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const audit = (event) => appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify(event) + "\\n");
const args = process.argv.slice(2);
audit({ type: "spawn", args });
if (args.includes("--version")) { console.log("2.1.248 (Claude Code)"); process.exit(0); }
if (args.some((arg) => ["login", "logout", "auth"].includes(arg))) { audit({ type: "forbidden-auth" }); process.exit(41); }
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  audit({ type: message.type, subtype: message.request?.subtype });
  if (message.type === "user") { audit({ type: "forbidden-inference" }); process.exit(42); }
  if (message.type !== "control_request") continue;
  if (message.request?.subtype !== "initialize") { process.exit(43); }
  console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {
    claude_code_version: "2.1.248", commands: [], agents: [], output_styles: [],
    account: { tokenSource: ${JSON.stringify(tokenSource)}, ...( ${JSON.stringify(tokenSource)} === "oauth" ? { email: "fixture@example.invalid", subscriptionType: "max" } : {}) },
    models: [{ value: "claude-sonnet-4-6", displayName: "Claude Sonnet fixture", description: "Synthetic discovery only", supportsEffort: false }]
  } } }));
}
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}
