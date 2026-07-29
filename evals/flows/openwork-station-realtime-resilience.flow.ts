import { defineFlow, type FlowContext } from "../runner/flow.ts";

type ScenarioStatus = {
  scenario?: {
    id?: string;
    status?: string;
    error?: string | null;
    observedEvents?: Array<{ name?: string }>;
  } | null;
  runtime?: { phase?: string };
  listening?: boolean;
  audioEnergy?: number;
  suggestionCount?: number;
  suggestionKinds?: string[];
  sourceProviders?: string[];
  reviewOnly?: boolean;
  error?: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readStatus(value: unknown): ScenarioStatus {
  return typeof value === "object" && value !== null ? value as ScenarioStatus : {};
}

async function runAndWait(ctx: FlowContext, scenarioId: string, timeoutMs = 60_000) {
  await ctx.control("station.scenario.run", {
    scenarioId,
    playbackSpeed: 1,
    realInference: true,
    resetBeforeRun: true,
    stopAfterRun: false,
  });
  const startedAt = Date.now();
  let latest: ScenarioStatus = {};
  while (Date.now() - startedAt < timeoutMs) {
    latest = readStatus(await ctx.control("station.scenario.status"));
    if (
      latest.scenario?.id === scenarioId
      && ["completed", "failed", "stopped"].includes(latest.scenario.status ?? "")
    ) {
      ctx.output(`${scenarioId} lifecycle`, JSON.stringify(latest, null, 2));
      return latest;
    }
    await sleep(650);
  }
  throw new Error(`Timed out waiting for ${scenarioId}: ${JSON.stringify(latest)}`);
}

function eventNames(status: ScenarioStatus) {
  return status.scenario?.observedEvents?.map((event) => event.name) ?? [];
}

function shouldRun(ctx: FlowContext, scenarioId: string) {
  const requested = ctx.env.OPENWORK_STATION_RESILIENCE_CASE
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return !requested?.length || requested.includes(scenarioId);
}

export default defineFlow({
  id: "openwork-station-realtime-resilience",
  title: "OpenWork Station survives silence, corrections, connected-data recovery, and immediate stop",
  kind: "internal",
  steps: [
    {
      name: "Ignore irrelevant ambient speech",
      run: async (ctx) => {
        if (!shouldRun(ctx, "ambient-speech")) return;
        const status = await runAndWait(ctx, "ambient-speech");
        ctx.assert(status.scenario?.status === "completed", status.scenario?.error ?? "Ambient scenario completed");
        ctx.assert(status.suggestionCount === 0, "Ambient speech produced no suggestion");
        ctx.assert(
          !eventNames(status).includes("station.realtime.tool_requested"),
          "The Realtime model did not call a tool for filler",
        );
      },
    },
    {
      name: "Replace a scheduling detail after correction",
      run: async (ctx) => {
        if (!shouldRun(ctx, "correction-over-time")) return;
        const status = await runAndWait(ctx, "correction-over-time");
        ctx.assert(status.scenario?.status === "completed", status.scenario?.error ?? "Correction scenario completed");
        ctx.assert(status.suggestionCount === 1, "One corrected suggestion replaced the earlier proposal");
        ctx.assert(status.suggestionKinds?.includes("calendar") === true, "The result remains a calendar draft");
        ctx.assert(
          status.sourceProviders?.includes("Development Calendar") === true,
          "The corrected draft cites connected calendar context",
        );
        ctx.assert(status.reviewOnly === true, "The calendar result remains review-only");
      },
    },
    {
      name: "Recover after connected context returns",
      run: async (ctx) => {
        if (!shouldRun(ctx, "mcp-recovery")) return;
        const status = await runAndWait(ctx, "mcp-recovery");
        ctx.assert(status.scenario?.status === "completed", status.scenario?.error ?? "Recovery scenario completed");
        ctx.assert(
          eventNames(status).includes("station.realtime.tool_failed"),
          "The unavailable connected-data turn was reported honestly",
        );
        ctx.assert(
          eventNames(status).includes("station.mcp.discovery_completed"),
          "A later spoken turn completed connected research",
        );
        ctx.assert(status.suggestionKinds?.includes("memory") === true, "Recovery surfaced the cited memory");
      },
    },
    {
      name: "Stop while fixture audio is active",
      run: async (ctx) => {
        if (!shouldRun(ctx, "immediate-stop")) return;
        const status = await runAndWait(ctx, "immediate-stop");
        ctx.assert(status.scenario?.status === "stopped", "The active scenario entered the stopped state");
        ctx.assert(status.listening === false, "Listening stopped immediately");
        ctx.assert(status.audioEnergy === 0, "Media energy returned to zero");
        ctx.assert(status.runtime?.phase === "stopped", "Late async events did not revive the run");
        ctx.assert(
          eventNames(status).includes("station.realtime.stopped"),
          "Session closure is visible in sanitized lifecycle metadata",
        );
      },
    },
  ],
});
