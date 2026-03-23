import { buildResponseHeaders, jsonResponse, rateLimitFormRequest, validateAntiSpamFields, validateTrustedOrigin, verifyFormBotProtection } from "../_lib/security";

import { getFeedbackEmailConfig } from "./config";
import { buildFeedbackEmailVariables } from "./template";

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
  website?: string;
  startedAt?: number | string;
  context?: FeedbackContext;
};

const LOOPS_TRANSACTIONAL_API_URL = "https://app.loops.so/api/v1/transactional";

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
  const originCheck = validateTrustedOrigin(request);
  if (!originCheck.ok) {
    return jsonResponse(request, { error: originCheck.error }, originCheck.status);
  }

  const rateLimit = rateLimitFormRequest(request, "app-feedback");
  if (!rateLimit.ok) {
    return new Response(JSON.stringify({ error: "Feedback form is temporarily rate limited." }), {
      status: 429,
      headers: {
        ...buildResponseHeaders(request),
        "X-Retry-After": String(rateLimit.retryAfterSeconds),
      },
    });
  }

  const botProtection = await verifyFormBotProtection();
  if (!botProtection.ok) {
    return jsonResponse(request, { error: botProtection.error }, botProtection.status);
  }

  const apiKey = process.env.LOOPS_API_KEY?.trim();
  const { internalEmail, templateName, transactionalId } =
    getFeedbackEmailConfig(process.env);

  if (!apiKey || !transactionalId) {
    return jsonResponse(
      request,
      { error: `${templateName} is not configured on this deployment.` },
      500,
    );
  }

  let payload: FeedbackPayload;
  try {
    const raw = await request.text();
    if (raw.length > 8000) {
      return jsonResponse(request, { error: "Request payload is too large." }, 413);
    }
    payload = JSON.parse(raw) as FeedbackPayload;
  } catch {
    return jsonResponse(request,
      { error: "Invalid request payload." },
      400,
    );
  }

  const antiSpam = validateAntiSpamFields(payload);
  if (!antiSpam.ok) {
    return jsonResponse(request, { error: antiSpam.error }, antiSpam.status);
  }

  const message = sanitizeValue(payload.message, 5000);
  const name = sanitizeValue(payload.name, 120);
  const email = sanitizeValue(payload.email, 240);

  if (!name) {
    return jsonResponse(request,
      { error: "Please include your name so we know who sent this." },
      400,
    );
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(request,
      { error: "Please include a valid email so we can follow up." },
      400,
    );
  }

  if (!message) {
    return jsonResponse(request,
      { error: "Please include a short message before sending feedback." },
      400,
    );
  }

  const context = sanitizeContext(payload.context);
  const diagnosticsSummary = formatDiagnosticsSummary(context);
  const submittedAt = new Date().toISOString();
  const templateVariables = buildFeedbackEmailVariables({
    name,
    email,
    message,
    submittedAt,
    context,
  });

  if (process.env.NODE_ENV === "development") {
    console.log("[DEV] Skipping Loops app feedback email", {
      internalEmail,
      templateName,
      transactionalId,
      message,
      name,
      email,
      context,
      templateVariables,
    });
    return jsonResponse(request, { ok: true });
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
        ...templateVariables,
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

    return jsonResponse(request, { error: detail }, 502);
  }

  return jsonResponse(request, { ok: true });
}
