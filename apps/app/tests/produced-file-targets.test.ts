import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { OpenWorkSpreadsheets } from "../../server/src/opencode-plugins/openwork-spreadsheets";
import { resolveWorkspaceArtifactTargets } from "../../server/src/routes/files";
import { deriveOpenTargets, isCollectibleArtifactTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { codeModeToolCalls } from "../src/lib/code-mode-tools";

function completed(toolName: string, output: unknown): DynamicToolUIPart {
  return { type: "dynamic-tool", toolCallId: "call-direct", toolName, state: "output-available", input: {}, output };
}
function conversation(part: DynamicToolUIPart, text = "All set."): UIMessage[] {
  return [{ id: "assistant-result", role: "assistant", parts: [part, { type: "text", text }] }];
}
function script(output: string): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName: "execute", toolCallId: "call-script", state: "output-error", input: { code: "return await tools.spreadsheet_write(args)" }, errorText: "The notification could not be sent.",
    callProviderMetadata: { openwork: { codeMode: {
      calls: [{ tool: "spreadsheet_write", status: "completed", input: {} }, { tool: "send_notification", status: "error", input: {} }],
      details: [
        { invocationId: "call-script:0", ordinal: 0, tool: "spreadsheet_write", input: {}, status: "completed", output },
        { invocationId: "call-script:1", ordinal: 1, tool: "send_notification", input: {}, status: "error", error: "The notification could not be sent." },
      ],
    } } },
  };
}

test("a shipping server writer emits file evidence only after a genuine workbook exists, independent of final wording or delivery route", async () => {
  const root = await mkdtemp(join(tmpdir(), "produced-file-target-"));
  try {
    const plugin = await OpenWorkSpreadsheets({ directory: root });
    const output = await plugin.tool.spreadsheet_write.execute({ path: "report.xlsx", sheets: [{ name: "Summary", rows: [["Total", 30]] }, { name: "Inputs", rows: [[10], [20]] }] });
    expect((await readFile(join(root, "report.xlsx"))).subarray(0, 2).toString()).toBe("PK");
    expect(JSON.parse(output).producedFiles[0].path).toBe("report.xlsx");
    for (const part of [completed("spreadsheet_write", output), script(output)]) {
      const original = JSON.stringify(part);
      const targets = deriveOpenTargets(conversation(part));
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ value: "report.xlsx", preview: "sheet", reason: "server-produced file", sourceMessageId: "assistant-result" });
      // A returned path is not proof of availability: only the server resolves it.
      expect(targets[0].exists).toBeUndefined();
      const resolved = await resolveWorkspaceArtifactTargets(root, targets);
      expect(resolved[0]).toMatchObject({ exists: true, value: "report.xlsx", sourceMessageId: "assistant-result" });
      expect(JSON.stringify(part)).toBe(original);
    }
    const localized = deriveOpenTargets([{ id: "localized", role: "assistant", parts: [{ type: "text", text: "Voici report.xlsx." }] }]);
    expect(localized[0]).toMatchObject({ value: "report.xlsx", reason: "message" });
    expect((await resolveWorkspaceArtifactTargets(root, localized))[0]).toMatchObject({ exists: true, value: "report.xlsx" });
    const inner = codeModeToolCalls(script(output));
    expect(inner?.[1]).toMatchObject({ state: "output-error", errorText: "The notification could not be sent." });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("older workers' complete atomic-write receipts remain discoverable without promoting bare paths", () => {
  const receipt = { ok: true, path: "legacy.xlsx", bytes: 42, sha256: "a".repeat(64) };
  expect(deriveOpenTargets(conversation(completed("spreadsheet_write", JSON.stringify(receipt))))[0]?.value).toBe("legacy.xlsx");
  expect(deriveOpenTargets(conversation(completed("spreadsheet_write", { ok: true, path: "bare.xlsx" })))).toEqual([]);
});

test("localized links and bare file references are unverified candidates, never claimed as produced files", async () => {
  const root = await mkdtemp(join(tmpdir(), "localized-file-negative-"));
  try {
    const messages: UIMessage[] = [{ id: "localized", role: "assistant", parts: [{ type: "text", text: "Voilà [résumé](report.pdf). fictional.xlsx" }] }];
    const targets = deriveOpenTargets(messages);
    expect(targets.map(target => target.value)).toEqual(["report.pdf", "fictional.xlsx"]);
    expect(targets.every(target => target.sourceMessageId === undefined && target.exists === undefined)).toBe(true);
    expect(targets.some(isCollectibleArtifactTarget)).toBe(false);
    const resolved = await resolveWorkspaceArtifactTargets(root, targets);
    expect(resolved.every(target => target.exists === false)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("assistant claims and duplicate routes cannot displace the producing turn's evidence", () => {
  const output = JSON.stringify({ ok: true, producedFiles: [{ path: "report.xlsx", bytes: 42 }] });
  const messages = conversation(completed("spreadsheet_write", output), "I saved report.xlsx.");
  messages.push({ id: "later-prose", role: "assistant", parts: [{ type: "text", text: "The file report.xlsx is ready." }] });
  messages[0].parts.push(script(output));
  const targets = deriveOpenTargets(messages);
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({ reason: "server-produced file", sourceMessageId: "assistant-result", preview: "sheet" });
});

test("inputs, failed writes, discovery results and fabricated arbitrary outputs are not produced files", () => {
  const payload = { ok: true, path: "invented.xlsx", producedFiles: [{ path: "invented.xlsx", bytes: 10 }] };
  const parts: DynamicToolUIPart[] = [
    completed("search", payload), completed("bash", JSON.stringify(payload)), completed("third_party_tool", payload),
    completed("spreadsheet_write", { ...payload, ok: false }),
    { type: "dynamic-tool", toolName: "write", toolCallId: "failed", state: "output-error", input: { filePath: "invented.xlsx" }, errorText: "Permission denied" },
    { type: "dynamic-tool", toolName: "openwork_extension_call", toolCallId: "pending", state: "input-available", input: { path: "invented.xlsx" } },
  ];
  for (const part of parts) expect(deriveOpenTargets(conversation(part))).toEqual([]);
});

test("even a malformed producer response cannot promote a nonexistent or outside file into an artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "produced-file-negative-"));
  try {
    const targets = deriveOpenTargets(conversation(completed("spreadsheet_write", { ok: true, producedFiles: [{ path: "missing.xlsx", bytes: 10 }, { path: "../outside.xlsx", bytes: 10 }] })));
    const resolved = await resolveWorkspaceArtifactTargets(root, targets);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ value: "missing.xlsx", exists: false });
    expect(resolved.some(target => target.exists === true)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
