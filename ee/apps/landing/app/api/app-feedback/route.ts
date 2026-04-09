import { buildResponseHeaders, jsonResponse, rateLimitFormRequest, validateAntiSpamFields, validateTrustedOrigin, verifyFormBotProtection } from "../_lib/security";

type FeedbackAttachment = {
  name?: string;
  fileKey?: string;
  accessUrl?: string;
  size?: number;
  contentType?: string;
};

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
  attachments?: FeedbackAttachment[];
  website?: string;
  startedAt?: number | string;
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

function sanitizeAttachments(input: FeedbackAttachment[] | undefined) {
  return (Array.isArray(input) ? input : [])
    .slice(0, 3)
    .map((attachment) => ({
      name: sanitizeValue(attachment?.name, 240),
      fileKey: sanitizeValue(attachment?.fileKey, 512),
      accessUrl: sanitizeValue(attachment?.accessUrl, 1200),
      size:
        typeof attachment?.size === "number" && Number.isFinite(attachment.size) && attachment.size > 0
          ? Math.round(attachment.size)
          : 0,
      contentType: sanitizeValue(attachment?.contentType, 120),
    }))
    .filter((attachment) => attachment.fileKey && attachment.accessUrl);
}

function formatFeedbackMessage(
  message: string,
  attachments: ReturnType<typeof sanitizeAttachments>,
) {
  if (!attachments.length) return message;

  const attachmentLines = attachments.map((attachment, index) => {
    const label = attachments.length === 1 ? "Screenshot" : `Screenshot ${index + 1}`;
    const suffix = attachment.name ? ` (${attachment.name})` : "";
    return `${label}${suffix}: ${attachment.accessUrl}`;
  });

  return `${message}\n\n${attachmentLines.join("\n")}`;
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
  const transactionalId =
    process.env.LOOPS_TRANSACTIONAL_ID_APP_FEEDBACK?.trim();
  const internalEmail =
    process.env.LOOPS_INTERNAL_FEEDBACK_EMAIL?.trim() ||
    DEFAULT_INTERNAL_FEEDBACK_EMAIL;

  if (!apiKey || !transactionalId) {
    return jsonResponse(
      request,
      { error: "App feedback is not configured on this deployment." },
      500,
    );
  }

  let payload: FeedbackPayload;
  try {
    const raw = await request.text();
    if (raw.length > 16000) {
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
  const attachments = sanitizeAttachments(payload.attachments);

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
  const formattedMessage = formatFeedbackMessage(message, attachments);

  if (process.env.NODE_ENV === "development") {
    console.log("[DEV] Skipping Loops app feedback email", {
      internalEmail,
      transactionalId,
      message: formattedMessage,
      name,
      email,
      attachments,
      context,
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
        name,
        email,
        message: formattedMessage,
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
