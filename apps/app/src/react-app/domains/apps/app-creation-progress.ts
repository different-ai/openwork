import type { DynamicToolUIPart, UIMessage } from "ai";
import { prepareMcpAppOutputSchema } from "@openwork/types/mcp-app";
import { getCapabilityCallSentence } from "@/lib/capability-call";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { skillEvidence } from "@/lib/skill-evidence";
import { codeModeHasFailures, codeModeToolCalls } from "@/lib/code-mode-tools";
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
  /** Earlier attempts at this App that were rejected before a retry succeeded. */
  attempts?: DynamicToolUIPart[];
  /**
   * The agent read the build-an-app guide (create) or an App
   * (edit) and is still writing, before any builder call exists.
   */
  intent?: { kind: "create" | "edit"; part: DynamicToolUIPart };
  /**
   * A Code Mode script the model is still writing that will
   * prepare, create or update an App. It is replaced by the script's own App
   * calls once it runs.
   */
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
  // Both engines also retain the MCP text projection. Older engines can omit metadata.
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

/** A step that succeeded but whose result an older engine did not record. */
export function appStepUnrecorded(part: DynamicToolUIPart | undefined): boolean {
  if (!part || part.state !== "output-available") return false;
  const result = field(part.callProviderMetadata?.openwork, "mcpResult");
  return field(field(result, "structuredContent"), "unrecorded") === true;
}

const BUILD_AN_APP_SKILL = /(?:^|[/:])build-an-app$/;

/** Reading the build-an-app guide, directly or as the only work of a Code Mode script. */
function isAppGuideCall(tool: string, input: unknown): boolean {
  if (!/(?:^|[_.])(?:get_skill|skill)$/.test(tool)) return false;
  const name = field(input, "name") ?? field(input, "capability");
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

// An App call a script made is keyed by that script, so the step it started
// while the script was being written stays the same element once it runs.
function stepId(part: DynamicToolUIPart): string {
  return part.toolCallId.split(":app:")[0] ?? part.toolCallId;
}

function codeOf(part: DynamicToolUIPart): string {
  const code = field(part.input, "code");
  return typeof code === "string" ? code : "";
}

/** The App call a Code Mode script being written will make, read from its streamed code. */
export function appScriptKind(part: DynamicToolUIPart): AppScriptKind | null {
  if (!part.callProviderMetadata?.openwork?.codeMode) return null;
  // A script result can arrive before its nested App calls. Keep the same
  // step through that handoff instead of briefly reverting to ordinary tools.

  const code = codeOf(part);
  if (/\bupdate_app\s*\(/.test(code)) return "update";
  if (/\bcreate_app\s*\(/.test(code)) return "create";
  if (/\bprepare_app\s*\(/.test(code)) return "prepare";
  return null;
}

/** The App title a builder call or script names, as far as it has streamed. */
export function appTitleInCall(part: DynamicToolUIPart | undefined): string | null {
  if (!part) return null;
  const title = field(part.input, "title");
  if (typeof title === "string" && title.trim()) return title.trim();
  const named = /\btitle\s*:\s*"((?:[^"\\]|\\.){1,120})"/.exec(codeOf(part))?.[1];
  return named ? named.replace(/\\(.)/g, "$1") : null;
}

/** Lines of App source written so far: the call's reactSource, or the script carrying it. */
export function appSourceLines(part: DynamicToolUIPart | undefined): number | null {
  if (!part) return null;
  const source = field(part.input, "reactSource");
  if (typeof source === "string") return source ? source.split("\n").length : null;
  // In a script the source sits in a string literal, its line breaks escaped.
  const code = codeOf(part);
  return code ? Math.max(code.split("\n").length, (code.match(/\\n/g)?.length ?? 0) + 1) : null;
}

/**
 * Calls that lead into an App step: finding capabilities, reading the
 * build-an-app guide, or reading an App to edit. They join the step the agent
 * opens next; on their own they stay ordinary steps.
 */
function isAppLeadInPart(part: DynamicToolUIPart): boolean {
  return /(?:^|_)search_capabilities$/.test(part.toolName) || isAppReadPart(part) || isAppGuidePart(part);
}

/** The App a read_app call names, with its title once the read returns. */
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

/**
 * App steps start only where the agent itself starts one: prepare_app, or a
 * create_app or update_app without a preparation. A guide starts the same
 * run early. Preparations and retries join the unfinished App by title, and
 * builds resolve its server-issued preparation ids to that stable run.
 *
 * While the turn is `live`, reading the build-an-app guide or an App starts
 * the step early, because writing the App's source can take a minute before
 * any builder call appears. Intervening tools do not end the run; a guide
 * without a builder is omitted from finished history.
 */
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
  // Preparations and Code Mode executions are attempts at the user's App,
  // not identities for the App. Preserve the first run through every retry.
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
  // A guide alone is useful during a live turn, but is not a completed App.
  // Actual attempts remain reconstructible after completion and on reload.
  if (!live) {
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index]!;
      if (!run.preparation && !run.builds.length && !run.script && !appCreationFailures(run).length) runs.splice(index, 1);
    }
  }
  for (const run of runs) {
    const calls = [...(run.discoveries ?? []), ...(run.preparation ? [run.preparation] : []), ...(run.attempts ?? []), ...run.builds];
    run.executions = [...parts.values()].filter(part => part.callProviderMetadata?.openwork?.codeMode && calls.some(call => call.toolCallId.startsWith(`${part.toolCallId}:app:`)));
    // The script still being written belongs to the step, not to the ordinary rows.
    if (run.script) run.executions.push(run.script.part);
  }
  return runs;
}

/** Real calls only; no inferred completion of earlier stages. */
export function appCreationParts(run: AppCreationRun): DynamicToolUIPart[] {
  return [...new Map([...(run.discoveries ?? []), ...(run.attempts ?? []),
    ...(run.preparation ? [run.preparation] : []), ...run.builds,
    ...(run.script ? [run.script.part] : []), ...(run.intent ? [run.intent.part] : []),
  ].map(part => [part.toolCallId, part])).values()];
}

/** A retry resolves a failure only when the same operation actually succeeds.
 * An outer script error remains its own row, independent of an App receipt. */
export function appCreationFailures(run: AppCreationRun): DynamicToolUIPart[] {
  const parts = appCreationParts(run);
  const guideLoaded = (part: DynamicToolUIPart) => {
    const calls = codeModeToolCalls(part);
    return skillEvidence(part)?.state === "instructions-loaded" || Boolean(calls?.length && calls.every(call =>
      isAppGuidePart(call) && skillEvidence(call)?.state === "instructions-loaded",
    ));
  };
  return parts.filter((part, index) => (appBuilderResultFailed(part) || skillEvidence(part)?.state === "blocked") && !parts.slice(index + 1).some(next =>
    (isAppGuidePart(part) ? isAppGuidePart(next) && guideLoaded(next) : next.toolName === part.toolName)
    && next.state === "output-available" && !appBuilderResultFailed(next),
  ));
}

/** Calls with their own App row need not be repeated in the script's rail.
 * Unprojected guide failures and the script's own outcome remain independent. */
export function unrepresentedAppCalls(part: DynamicToolUIPart, represented: ReadonlySet<string>): DynamicToolUIPart[] | null {
  const calls = codeModeToolCalls(part);
  if (!calls) return null;
  const occurrences = new Map<string, number>();
  return calls.filter(call => {
    const occurrence = occurrences.get(call.toolName) ?? 0;
    occurrences.set(call.toolName, occurrence + 1);
    return !represented.has(`${part.toolCallId}:app:${call.toolName}:${occurrence}`);
  });
}

/** Only calls represented by the App row fold into it. A script's own failure
 * or unrelated work is not an App-stage outcome and keeps its ordinary row. */
export function foldedAppCreationPartIds(runs: AppCreationRun[]): Set<string> {
  return new Set(runs.flatMap(run => {
    const represented = new Set(appCreationParts(run).filter(part => !codeModeHasFailures(part) || appBuilderResultFailed(part)).map(part => part.toolCallId));
    const executions = (run.executions ?? []).filter(part => {
      if (appBuilderResultFailed(part)) return false;
      const calls = unrepresentedAppCalls(part, represented);
      // A lead-in inside a mixed script is not necessarily projected into the
      // App row. Fold only calls whose individual outcome has a visible home.
      return calls !== null && calls.length === 0;
    });
    return [...represented, ...executions.map(part => part.toolCallId)];
  }));
}

export function appCreationProgress(run: AppCreationRun, active: boolean) {
  const preparation = appPreparation(run.preparation);
  const build = run.builds.at(-1);
  const app = build ? builtAppSummary(build) : null;
  const failures = appCreationFailures(run);
  const failed = failures.length > 0;
  const checking = build?.state === "input-available";
  // Built, but the launch was not recorded: done, just not previewable here.
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
  // Completion without a verified launch is not success (e.g. catalog capacity).
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
    failures,
    unavailable,
    builtUnrecorded,
    running,
  };
}

/** Keep the App's home through retries; only readiness ends the live panel. */
export function appBuildInProgress(messages: UIMessage[]): boolean {
  const turn = messages.slice(Math.max(0, messages.findLastIndex((message) => message.role === "user")));
  return appCreationRuns(turn, true).some(run => {
    const progress = appCreationProgress(run, true);
    return !progress.failed && !progress.unavailable && !progress.app && !progress.builtUnrecorded;
  });
}

function lastLine(text: string): string | null {
  const lines = text.replace(/[*_`#>]+/g, "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1);
  return line ? (line.length > 140 ? `${line.slice(0, 139)}…` : line) : null;
}

/**
 * What the agent is doing right now while it builds an App, in one line: its
 * latest thought, or the latest call that is not part of the App step.
 */
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

