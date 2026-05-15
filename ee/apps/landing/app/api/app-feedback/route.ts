import { buildResponseHeaders, jsonResponse, rateLimitFormRequest, validateAntiSpamFields, validateTrustedOrigin, verifyFormBotProtection } from "../_lib/security";
import { EmailSendError, sendEmail, type FeedbackEmailProps } from "@openwork/email";

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

  const internalEmail =
    process.env.OPENWORK_FEEDBACK_EMAIL?.trim() ||
    process.env.LOOPS_INTERNAL_FEEDBACK_EMAIL?.trim() ||
    DEFAULT_INTERNAL_FEEDBACK_EMAIL;

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

  const feedbackProps = {
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
  } satisfies FeedbackEmailProps;

  try {
    await sendEmail({
      to: internalEmail,
      template: "feedback",
      props: feedbackProps,
      config: {
        devMode: process.env.NODE_ENV === "development",
        from: process.env.EMAIL_FROM?.trim(),
        resendApiKey: process.env.RESEND_API_KEY?.trim(),
        smtp: {
          host: process.env.SMTP_HOST?.trim(),
          port: Number(process.env.SMTP_PORT ?? "587"),
          user: process.env.SMTP_USER?.trim(),
          pass: process.env.SMTP_PASS,
          secure: (process.env.SMTP_SECURE ?? "false").toLowerCase() === "true",
        },
      },
    });
  } catch (error) {
    if (error instanceof EmailSendError) {
      return jsonResponse(request, { error: error.detail ?? error.message }, 502);
    }
    throw error;
  }

  return jsonResponse(request, { ok: true });
}
