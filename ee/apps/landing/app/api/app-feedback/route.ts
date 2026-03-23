import { NextResponse } from "next/server";

type FeedbackContext = {
  source?: string;
  entrypoint?: string;
  deployment?: string;
  appVersion?: string;
  openworkServerVersion?: string;
  opencodeVersion?: string;
  orchestratorVersion?: string;
  opencodeRouterVersion?: string;
  osName?: string;
  osVersion?: string;
  platform?: string;
};

type FeedbackPayload = {
  name?: string;
  email?: string;
  message?: string;
  context?: FeedbackContext;
};

const LOOPS_TRANSACTIONAL_API_URL = "https://app.loops.so/api/v1/transactional";
const DEFAULT_INTERNAL_FEEDBACK_EMAIL = "team@openworklabs.com";

function sanitizeValue(value: unknown, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sanitizeContext(input: FeedbackContext | undefined) {
  return {
    source: sanitizeValue(input?.source),
    entrypoint: sanitizeValue(input?.entrypoint),
    deployment: sanitizeValue(input?.deployment),
    appVersion: sanitizeValue(input?.appVersion),
    openworkServerVersion: sanitizeValue(input?.openworkServerVersion),
    opencodeVersion: sanitizeValue(input?.opencodeVersion),
    orchestratorVersion: sanitizeValue(input?.orchestratorVersion),
    opencodeRouterVersion: sanitizeValue(input?.opencodeRouterVersion),
    osName: sanitizeValue(input?.osName),
    osVersion: sanitizeValue(input?.osVersion),
    platform: sanitizeValue(input?.platform),
  };
}

function formatDiagnosticsSummary(context: ReturnType<typeof sanitizeContext>) {
  const osLabel = [context.osName, context.osVersion].filter(Boolean).join(" ");
  const lines = [
    ["Source", context.source],
    ["Entrypoint", context.entrypoint],
    ["Deployment", context.deployment],
    ["App version", context.appVersion],
    ["OpenWork server", context.openworkServerVersion],
    ["OpenCode", context.opencodeVersion],
    ["Orchestrator", context.orchestratorVersion],
    ["Router", context.opencodeRouterVersion],
    ["OS", osLabel],
    ["Platform", context.platform],
  ].filter(([, value]) => value);

  return lines.map(([label, value]) => `${label}: ${value}`).join("\n");
}

export async function POST(request: Request) {
  const apiKey = process.env.LOOPS_API_KEY?.trim();
  const transactionalId =
    process.env.LOOPS_TRANSACTIONAL_ID_APP_FEEDBACK?.trim();
  const internalEmail =
    process.env.LOOPS_INTERNAL_FEEDBACK_EMAIL?.trim() ||
    DEFAULT_INTERNAL_FEEDBACK_EMAIL;

  if (!apiKey || !transactionalId) {
    return NextResponse.json(
      { error: "App feedback is not configured on this deployment." },
      { status: 500 },
    );
  }

  let payload: FeedbackPayload;
  try {
    payload = (await request.json()) as FeedbackPayload;
  } catch {
    return NextResponse.json(
      { error: "Invalid request payload." },
      { status: 400 },
    );
  }

  const message = sanitizeValue(payload.message, 5000);
  const name = sanitizeValue(payload.name, 120);
  const email = sanitizeValue(payload.email, 240);

  if (!name) {
    return NextResponse.json(
      { error: "Please include your name so we know who sent this." },
      { status: 400 },
    );
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: "Please include a valid email so we can follow up." },
      { status: 400 },
    );
  }

  if (!message) {
    return NextResponse.json(
      { error: "Please include a short message before sending feedback." },
      { status: 400 },
    );
  }

  const context = sanitizeContext(payload.context);
  const diagnosticsSummary = formatDiagnosticsSummary(context);
  const submittedAt = new Date().toISOString();

  if (process.env.NODE_ENV === "development") {
    console.log("[DEV] Skipping Loops app feedback email", {
      internalEmail,
      transactionalId,
      message,
      name,
      email,
      context,
    });
    return NextResponse.json({ ok: true });
  }

  const response = await fetch(LOOPS_TRANSACTIONAL_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transactionalId,
      email: internalEmail,
      dataVariables: {
        name,
        email,
        message,
        source: context.source || "openwork-app",
        entrypoint: context.entrypoint || "unknown",
        deployment: context.deployment || "desktop",
        appVersion: context.appVersion || "unknown",
        openworkServerVersion: context.openworkServerVersion || "unknown",
        opencodeVersion: context.opencodeVersion || "unknown",
        orchestratorVersion: context.orchestratorVersion || "unknown",
        opencodeRouterVersion: context.opencodeRouterVersion || "unknown",
        osName: context.osName || "unknown",
        osVersion: context.osVersion || "",
        platform: context.platform || "unknown",
        diagnosticsSummary,
        submittedAt,
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    let detail = "Failed to send feedback email.";

    try {
      const errorBody = await response.text();
      if (errorBody.trim()) {
        detail = errorBody.slice(0, 600);
      }
    } catch {
      // Ignore invalid upstream error bodies.
    }

    return NextResponse.json({ error: detail }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
