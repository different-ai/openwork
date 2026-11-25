import type { DynamicToolUIPart, UIMessage } from "ai";
import { prepareMcpAppOutputSchema } from "@openwork/types/mcp-app";
import { getCapabilityCallSentence } from "@/lib/capability-call";
import { isToolPartInFlight } from "@/lib/tool-activity";
import {
  appBuilderResultFailed,
  builtAppSummary,
  isAppBuilderPart,
} from "./built-mcp-app-model";

export type AppCreationRun = {
  id: string;
  startedAt?: number;
  preparation?: DynamicToolUIPart;
  discoveries?: DynamicToolUIPart[];
  executions?: DynamicToolUIPart[];
  builds: DynamicToolUIPart[];
  attempts?: DynamicToolUIPart[];
  intent?: { kind: "create" | "edit"; part: DynamicToolUIPart };
  script?: { kind: AppScriptKind; part: DynamicToolUIPart };
};
export type AppScriptKind = "prepare" | "create" | "update";
export type AppCreationStage = "needs" | "writing" | "checking" | "ready";

export function isAppPreparationPart(part: DynamicToolUIPart): boolean {
  return /(?:^|_)prepare_app$/.test(part.toolName);
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

export function appPreparation(part: DynamicToolUIPart | undefined) {
  if (
    !part ||
    part.state !== "output-available" ||
    appBuilderResultFailed(part)
  )
    return null;
  const result = field(part.callProviderMetadata?.openwork, "mcpResult");
  const structured = prepareMcpAppOutputSchema.safeParse(
    field(result, "structuredContent"),
  );
  if (structured.success) return structured.data;
  let output: unknown = part.output;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return null;
    }
  }
  const parsed = prepareMcpAppOutputSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
}

export function appStepUnrecorded(part: DynamicToolUIPart | undefined): boolean {
  if (!part || part.state !== "output-available") return false;
  const result = field(part.callProviderMetadata?.openwork, "mcpResult");
  return field(field(result, "structuredContent"), "unrecorded") === true;
}

const BUILD_AN_APP_SKILL = /(?:^|[/:]|^openwork-cloud-)build-an-app$/;

function isAppGuideCall(tool: string, input: unknown): boolean {
  if (!/(?:^|[_.])(?:get_skill|skill)$/.test(tool)) return false;
  const name = field(input, "name") ?? field(input, "capability") ?? field(input, "id");
  return typeof name === "string" && BUILD_AN_APP_SKILL.test(name);
}

export function isAppGuidePart(part: DynamicToolUIPart): boolean {
  if (isAppGuideCall(part.toolName, part.input)) return true;
  const calls = field(part.callProviderMetadata?.openwork?.codeMode, "calls");
  return Array.isArray(calls) && calls.length > 0 && calls.every((call) => {
    const tool = field(call, "tool");
    return typeof tool === "string" && isAppGuideCall(tool, field(call, "input"));
  });
}

function isAppReadPart(part: DynamicToolUIPart): boolean {
  return /(?:^|_)read_app$/.test(part.toolName);
}

function stepId(part: DynamicToolUIPart): string {
  return part.toolCallId.split(":app:")[0] ?? part.toolCallId;
}

function codeOf(part: DynamicToolUIPart): string {
  const code = field(part.input, "code");
  return typeof code === "string" ? code : "";
}

export function appScriptKind(part: DynamicToolUIPart): AppScriptKind | null {
  if (!part.callProviderMetadata?.openwork?.codeMode) return null;

  const code = codeOf(part);
  if (/\bupdate_app\s*\(/.test(code)) return "update";
  if (/\bcreate_app\s*\(/.test(code)) return "create";
  if (/\bprepare_app\s*\(/.test(code)) return "prepare";
  return null;
}

export function appTitleInCall(part: DynamicToolUIPart | undefined): string | null {
  if (!part) return null;
  const title = field(part.input, "title");
  if (typeof title === "string" && title.trim()) return title.trim();
  const named = /\btitle\s*:\s*"((?:[^"\\]|\\.){1,120})"/.exec(codeOf(part))?.[1];
  return named ? named.replace(/\\(.)/g, "$1") : null;
}

export function appSourceLines(part: DynamicToolUIPart | undefined): number | null {
  if (!part) return null;
  const source = field(part.input, "reactSource");
  if (typeof source === "string") return source ? source.split("\n").length : null;
  const code = codeOf(part);
  return code ? Math.max(code.split("\n").length, (code.match(/\\n/g)?.length ?? 0) + 1) : null;
}

function isAppLeadInPart(part: DynamicToolUIPart): boolean {
  return /(?:^|_)search_capabilities$/.test(part.toolName) || isAppReadPart(part) || isAppGuidePart(part);
}

export function appRead(part: DynamicToolUIPart | undefined): { appId: string; title: string | null } | null {
  if (!part || !isAppReadPart(part)) return null;
  const appId = field(part.input, "appId");
  if (typeof appId !== "string" || !appId) return null;
  let output: unknown = part.state === "output-available" ? part.output : undefined;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      output = undefined;
    }
  }
  const structured = field(field(part.callProviderMetadata?.openwork, "mcpResult"), "structuredContent");
  const title = field(field(structured, "app"), "title") ?? field(field(output, "app"), "title");
  return { appId, title: typeof title === "string" && title.trim() ? title : null };
}

export function appCreationRuns(messages: UIMessage[], live = false): AppCreationRun[] {
  const runs: AppCreationRun[] = [];
  const byPreparation = new Map<string, AppCreationRun>();
  const parts = new Map<string, DynamicToolUIPart>();
  const starts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "dynamic-tool") {
        parts.set(part.toolCallId, part);
        const created = field(field(message.metadata, "opencode"), "created");
        if (typeof created === "number" && Number.isFinite(created)) starts.set(part.toolCallId, created);
      }
    }
  }
  let leadIn: DynamicToolUIPart[] = [];
  const join = (run: AppCreationRun) => {
    if (leadIn.length) run.discoveries = [...(run.discoveries ?? []), ...leadIn];
    leadIn = [];
  };
  const unfinished = (run: AppCreationRun | undefined) => run
    && !run.builds.some(build => builtAppSummary(build) || appStepUnrecorded(build));
  const continuing = (part: DynamicToolUIPart) => {
    const latest = runs.at(-1);
    if (!unfinished(latest) || !latest) return undefined;
    const title = appTitleInCall(part);
    const previousTitle = appCreationProgress(latest, false).title;
    return title && previousTitle && title !== previousTitle ? undefined : latest;
  };
  const start = (part: DynamicToolUIPart) => {
    const id = leadIn[0]?.toolCallId ?? stepId(part);
    const run: AppCreationRun = { id, startedAt: starts.get(id) ?? starts.get(part.toolCallId), builds: [] };
    join(run);
    runs.push(run);
    return run;
  };
  const runsInner = (part: DynamicToolUIPart) => [...parts.keys()].some(id => id.startsWith(`${part.toolCallId}:app:`));
  for (const part of parts.values()) {
    const scriptKind = appScriptKind(part);
    if (scriptKind && !runsInner(part)) {
      const run = continuing(part) ?? start(part);
      run.script = { kind: scriptKind, part };
      join(run);
    } else if (isAppLeadInPart(part)) {
      const latest = runs.at(-1);
      if (unfinished(latest) && latest) {
        latest.discoveries = [...(latest.discoveries ?? []), part];
      } else if (isAppGuidePart(part) || isAppReadPart(part)) {
        const run = start(part);
        run.intent = { kind: isAppReadPart(part) ? "edit" : "create", part };
        run.discoveries = [...(run.discoveries ?? []), part];
      } else leadIn.push(part);
    } else if (isAppPreparationPart(part)) {
      const run = continuing(part) ?? start(part);
      if (run.preparation) run.attempts = [...(run.attempts ?? []), run.preparation];
      if (run.builds.length) {
        run.attempts = [...(run.attempts ?? []), ...run.builds];
        run.builds = [];
      }
      run.preparation = part;
      run.script = undefined;
      join(run);
      const preparation = appPreparation(part);
      if (preparation) byPreparation.set(preparation.preparationId, run);
    } else if (isAppBuilderPart(part)) {
      const id = field(part.input, "preparationId");
      const run = (typeof id === "string" ? byPreparation.get(id) : undefined)
        ?? continuing(part) ?? start(part);
      run.builds.push(part);
      run.script = undefined;
      join(run);
    } else if (!unfinished(runs.at(-1)) && !part.callProviderMetadata?.openwork?.codeMode) {
      leadIn = [];
    }
  }
  if (!live) {
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index]!;
      if (!run.preparation && !run.builds.length && !run.script) runs.splice(index, 1);
    }
  }
  for (const run of runs) {
    const calls = [...(run.discoveries ?? []), ...(run.preparation ? [run.preparation] : []), ...(run.attempts ?? []), ...run.builds];
    run.executions = [...parts.values()].filter(part => part.callProviderMetadata?.openwork?.codeMode && calls.some(call => call.toolCallId.startsWith(`${part.toolCallId}:app:`)));
    if (run.script) run.executions.push(run.script.part);
  }
  return runs;
}

export function appCreationProgress(run: AppCreationRun, active: boolean) {
  const preparation = appPreparation(run.preparation);
  const build = run.builds.at(-1);
  const app = build ? builtAppSummary(build) : null;
  const failed = Boolean(
    (build && appBuilderResultFailed(build)) ||
      (!build && run.preparation && appBuilderResultFailed(run.preparation)) ||
      (run.script && appBuilderResultFailed(run.script.part)),
  );
  const checking = build?.state === "input-available";
  const builtUnrecorded = appStepUnrecorded(build);
  const prepared = Boolean(preparation) || appStepUnrecorded(run.preparation) || builtUnrecorded;
  const stage: AppCreationStage = app || builtUnrecorded
    ? "ready"
    : checking || (build && failed)
      ? "checking"
      : prepared || build || run.intent?.kind === "edit" || (run.script && run.script.kind !== "prepare")
        ? "writing"
        : "needs";
  const title =
    app?.title ??
    field(build?.input, "title") ??
    preparation?.title ??
    field(run.preparation?.input, "title") ??
    appTitleInCall(run.script?.part) ??
    run.discoveries?.map(appRead).find(read => read?.title)?.title;
  const detail = field(run.preparation?.input, "description");
  const unavailable = Boolean(
    !failed &&
      !builtUnrecorded &&
      ((build?.state === "output-available" && !app) ||
        (!build && run.preparation?.state === "output-available" && !prepared)),
  );
  const running = active && !failed && !unavailable && !app && !builtUnrecorded;
  return {
    stage,
    title: typeof title === "string" && title ? title : null,
    prepared,
    detail: typeof detail === "string" ? detail.slice(0, 140) : null,
    preparation,
    build,
    app,
    failed,
    unavailable,
    builtUnrecorded,
    running,
  };
}

export function appBuildInProgress(messages: UIMessage[]): boolean {
  const turn = messages.slice(Math.max(0, messages.findLastIndex((message) => message.role === "user")));
  return appCreationRuns(turn, true).some(run => {
    const progress = appCreationProgress(run, true);
    return !progress.app && !progress.builtUnrecorded;
  });
}

function lastLine(text: string): string | null {
  const lines = text.replace(/[*_`#>]+/g, "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1);
  return line ? (line.length > 140 ? `${line.slice(0, 139)}…` : line) : null;
}

export function appBuildActivity(messages: UIMessage[], appParts: ReadonlySet<string>, showThinking = false): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return null;
    if (message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]!;
      if (part.type === "reasoning" && showThinking) {
        const line = lastLine(part.text);
        if (line) return line;
      } else if (part.type === "dynamic-tool" && (!appParts.has(part.toolCallId) || isToolPartInFlight(part))) {
        const sentence = getCapabilityCallSentence(part);
        return isToolPartInFlight(part) ? sentence.present : sentence.past;
      }
    }
  }
  return null;
}

