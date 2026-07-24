import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, debuggerUrlFor, pickAppTarget } from "./cdp.ts";
import { EvalContext } from "./context.ts";
import { checkVoiceoverCoverage, loadVoiceoverParagraphs } from "./voiceover.ts";
import type { EvalMode, Evidence, FlowDefinition, FlowResult, LoadedFlow, StepResult } from "./flow.ts";
import type { CdpClient } from "./cdp.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFlowDefinition(value: unknown): value is FlowDefinition {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.title !== "string") return false;
  if (value.kind !== undefined && value.kind !== "user-facing" && value.kind !== "internal") return false;
  if (value.spec !== undefined && typeof value.spec !== "string") return false;
  if (value.requiredEnv !== undefined && !isStringArray(value.requiredEnv)) return false;
  if (value.requiresApp !== undefined && typeof value.requiresApp !== "boolean") return false;
  if (value.preserveTheme !== undefined && typeof value.preserveTheme !== "boolean") return false;
  if (value.precondition !== undefined && typeof value.precondition !== "function") return false;
  if (!Array.isArray(value.steps)) return false;
  return value.steps.every((step) => isRecord(step) && typeof step.name === "string" && typeof step.run === "function");
}

export async function loadFlows(flowsDir: string): Promise<LoadedFlow[]> {
  const entries = await readdir(flowsDir);
  const flows: LoadedFlow[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".flow.mjs") && !entry.endsWith(".flow.ts")) continue;
    const flowModule: unknown = await import(pathToFileURL(join(flowsDir, entry)).href);
    const flow = isRecord(flowModule) ? flowModule.default : undefined;
    if (!isFlowDefinition(flow)) {
      throw new Error(`Flow file ${entry} must default-export { id, title, steps }.`);
    }
    flows.push({ ...flow, file: entry });
  }
  return flows;
}

export function missingEnv(flow: FlowDefinition, env: NodeJS.ProcessEnv): string[] {
  return (flow.requiredEnv ?? []).filter((name) => !env[name]?.trim());
}

function collectRecordedVoiceovers(steps: StepResult[]): string[] {
  const recorded = new Set<string>();
  for (const step of steps) {
    for (const evidence of step.evidence ?? []) {
      if ((evidence.type === "claim" || evidence.type === "frame") && evidence.voiceover) {
        recorded.add(evidence.voiceover);
      }
    }
  }
  return [...recorded];
}

async function appendVoiceoverCoverageStep(flow: FlowDefinition, result: FlowResult): Promise<void> {
  const paragraphs = await loadVoiceoverParagraphs(flow.id);
  if (!paragraphs) return;
  const coverage = checkVoiceoverCoverage(paragraphs, collectRecordedVoiceovers(result.steps));
  const evidence: Evidence[] = paragraphs.map((paragraph, index) => ({
    type: "assertion",
    status: coverage.missing.includes(paragraph) ? "failed" : "passed",
    assertion: `Script frame ${index + 1} narrated: ${JSON.stringify(paragraph.slice(0, 88))}`,
  }));
  for (const line of coverage.extra) {
    evidence.push({ type: "assertion", status: "failed", assertion: `Narration not in the approved script: ${JSON.stringify(line.slice(0, 88))}` });
  }
  result.steps.push({
    name: "Voice-over script coverage",
    status: coverage.ok ? "passed" : "failed",
    durationMs: 0,
    error: coverage.ok ? null : `Narration drifted from evals/voiceovers/${flow.id}.md (${coverage.missing.length} missing, ${coverage.extra.length} unapproved).`,
    evidence,
  });
  if (!coverage.ok) result.status = "failed";
}

export interface RunFlowOptions {
  cdpBaseUrl: string | null;
  outDir: string;
  env: NodeJS.ProcessEnv;
  mode: EvalMode;
}

export async function runFlow(flow: FlowDefinition, { cdpBaseUrl, outDir, env, mode }: RunFlowOptions): Promise<FlowResult> {
  const result: FlowResult = {
    id: flow.id,
    title: flow.title,
    spec: flow.spec ?? null,
    kind: flow.kind ?? null,
    status: "passed",
    skipReason: null,
    steps: [],
    logs: [],
  };

  const missing = missingEnv(flow, env);
  if (missing.length > 0) {
    result.status = "skipped";
    result.skipReason = `Missing env: ${missing.join(", ")}`;
    return result;
  }

  // Flows with `requiresApp: false` (e.g. DX/tooling demos) run without a CDP
  // connection: their frames are claims + assertions + recorded outputs.
  const requiresApp = flow.requiresApp !== false;
  let client: CdpClient | null = null;
  if (requiresApp) {
    if (!cdpBaseUrl) throw new Error(`Flow ${flow.id} requires an app CDP endpoint.`);
    const target = await pickAppTarget(cdpBaseUrl);
    client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  }
  const ctx = new EvalContext({ client, outDir, flowId: flow.id, env, cdpBaseUrl });

  try {
    // Force light mode by default so screenshot evidence is readable. Flows
    // that are themselves testing theme/dark-mode behavior can opt out with
    // `preserveTheme: true` in the flow definition.
    if (requiresApp && !flow.preserveTheme) {
      try {
        await ctx.ensureLightMode();
      } catch (error) {
        ctx.log(`Could not force light mode (continuing anyway): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (typeof flow.precondition === "function") {
      const startedAt = Date.now();
      try {
        const skipReason = await flow.precondition(ctx);
        if (skipReason) {
          result.status = "skipped";
          result.skipReason = String(skipReason);
          return result;
        }
      } catch (error) {
        result.status = "failed";
        result.steps.push({
          name: "Precondition",
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          evidence: [],
        });
        if (client) await ctx.screenshot("failure").catch(() => undefined);
        return result;
      }
    }
    for (const step of flow.steps) {
      const stepResult: StepResult = { name: step.name, status: "passed", durationMs: 0, error: null, evidence: [] };
      const startedAt = Date.now();
      ctx.beginStep(step.name);
      try {
        await step.run(ctx);
      } catch (error) {
        stepResult.status = "failed";
        stepResult.error = error instanceof Error ? error.message : String(error);
        result.status = "failed";
      } finally {
        stepResult.evidence = ctx.endStep();
      }
      stepResult.durationMs = Date.now() - startedAt;
      result.steps.push(stepResult);
      if (stepResult.status === "failed") {
        if (client) await ctx.screenshot("failure").catch(() => undefined);
        break;
      }
    }

    // Demo mode keeps the original voice-over drift policy. Automation mode is
    // deliberately decoupled from narration so regression checks can stay plain.
    if (mode === "demo" && result.status === "passed") {
      await appendVoiceoverCoverageStep(flow, result);
    }
  } finally {
    result.screenshots = ctx.screenshots;
    result.evidenceFrames = ctx.evidenceFrames;
    result.logs = ctx.logs;
    ctx.client?.close();
  }

  return result;
}
