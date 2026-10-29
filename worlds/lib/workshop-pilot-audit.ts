import { browserScript } from "../../evals/packages/cdp/src/index.ts";
import type { Surface } from "../../evals/packages/cdp/src/index.ts";
import { evalIn } from "../../evals/packages/behaviors/src/desktop.ts";
import type { EngineSessionProbePart } from "../../evals/packages/behaviors/src/engine-session-probe.ts";

export interface WorkshopReadAudit { service: string; entry: Record<string, unknown> }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export async function readWorkshopAudit(browser: Surface): Promise<WorkshopReadAudit[]> {
  const value = await evalIn(browser, browserScript(async () => {
    const results = [];
    for (const service of ["microsoft", "atlassian"]) {
      const response = await fetch(`/_workshop/state/${service}`);
      if (!response.ok) throw new Error(`Own guest service audit HTTP ${response.status}`);
      results.push({ service, body: await response.json() });
    }
    return results;
  }, []), { timeoutMs: 45_000 });
  const entries: WorkshopReadAudit[] = [];
  if (!Array.isArray(value)) throw new Error("Own guest audit did not return service snapshots");
  for (const item of value) {
    if (!record(item) || typeof item.service !== "string" || !record(item.body) || !Array.isArray(item.body.audit)) throw new Error("Own guest service audit is unavailable");
    for (const entry of item.body.audit.filter(record)) entries.push({ service: item.service, entry });
  }
  return entries;
}
function normalized(text: string) { return text.toLowerCase().replace(/\s+/g, " ").trim(); }
function titlesFrom(value: unknown): string[] {
  const titles: string[] = [];
  function visit(value: unknown, key: string, depth: number) {
    if (depth > 12) return;
    if (typeof value === "string") {
      if (/^(title|subject|summary)$/i.test(key) && value.trim().length >= 8) titles.push(value.trim());
      try { const parsed: unknown = JSON.parse(value); if (parsed !== value) visit(parsed, "", depth + 1); } catch { /* Provider text. */ }
    } else if (Array.isArray(value)) { for (const child of value) visit(child, key, depth + 1); }
    else if (record(value)) { for (const [key, child] of Object.entries(value)) visit(child, key, depth + 1); }
  }
  visit(value, "", 0); return titles;
}

/** Code Mode wraps the real MCP call in execute. Require the actual completed
 * invocation AND a fresh independent audit from this guest's service, not a
 * model claim or a synthetic engine result. Callers must filter audit cursors. */
export function validateAuditedPilotRead(parts: readonly EngineSessionProbePart[], finalText: string, connectionIds: readonly string[], audit: readonly WorkshopReadAudit[], marker = "WORKSHOP_READY") {
  if (!/northwind/i.test(finalText) || !finalText.includes(marker)) throw new Error("Pilot final response lacks its grounded readiness marker");
  const readOperation = (name: string) => /^(jira|mail|outlook)_/i.test(name) && /read|search|list|get|find|query/i.test(name)
    && !/create|update|delete|send|write|patch|remove|add|upload|draft|mark|move|copy|archive|restore|forward|reply|assign/i.test(name);
  if (audit.some(({ entry }) => !readOperation(String(entry.name)))) throw new Error("Read-only pilot attempted an unexpected or mutating workplace operation");
  if (audit.length > 2) throw new Error("Read-only pilot exceeded its two workplace-call bound");
  for (const { service, entry } of audit) {
    const operation = typeof entry.name === "string" ? entry.name : "";
    if (entry.status !== "completed" || !readOperation(operation)) continue;
    const output = typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output);
    if (!output || !/northwind/i.test(output) || /"isError"\s*:\s*true/i.test(output)) continue;
    const title = titlesFrom(entry.output).find((title) => normalized(finalText).includes(normalized(title)));
    if (!title) continue;
    const invocation = parts.find((part) => {
      if (part.type !== "tool" || part.status !== "completed" || part.error) return false;
      const descriptor = `${part.tool} ${JSON.stringify(part.input)}`;
      const workplace = connectionIds.some((id) => descriptor.includes(id)) || /workshop[-_ ](?:jira|outlook)/i.test(descriptor);
      const bypass = /\bfetch\s*\(|\b(?:curl|wget|spawn|execFile|execSync|python3?|bash)\b|\bprocess\./i.test(descriptor);
      const input = JSON.stringify(entry.input) ?? "";
      const lookup = /northwind/i.test(input) && /northwind/i.test(descriptor)
        || [...input.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)].some((match) => descriptor.includes(match[0]));
      return workplace && descriptor.includes(operation) && lookup && !bypass;
    });
    if (invocation) return { source: "independent-member-service-audit", service, tool: operation, engineTool: invocation.tool, callId: invocation.callId, title, completed: true };
  }
  throw new Error("Pilot lacks a correlated completed MCP invocation and fresh member-service read matching its final fact");
}
