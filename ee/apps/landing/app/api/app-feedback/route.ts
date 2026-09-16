import { buildResponseHeaders, jsonResponse, rateLimitFormRequest, validateAntiSpamFields, validateTrustedOrigin, verifyFormBotProtection } from "../_lib/security";
import { createPlainFormClient } from "../_lib/plain";
import { ForbiddenError } from "@team-plain/graphql";
import { buildFeedbackThreadFields, type FeedbackContext } from "../../../lib/plain-feedback-fields";

type FeedbackPayload = {
  name?: string;
  email?: string;
  message?: string;
  website?: string;
  startedAt?: number | string;
  mode?: string;
  context?: FeedbackContext;
};

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
    osName: sanitizeValue(input?.osName),
    osVersion: sanitizeValue(input?.osVersion),
    platform: sanitizeValue(input?.platform),
  };
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
  const mode = sanitizeValue(payload.mode, 40) === "contact" ? "contact" : "feedback";

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
  const submittedAt = new Date().toISOString();

  const apiKey = process.env.PLAIN_API_KEY?.trim();
  if (!apiKey) {
    return jsonResponse(request, {
      error: "This form is temporarily unavailable. Please email team@openworklabs.com.",
    }, 503);
  }

  let operation = "upsertCustomer";
  try {
    const plain = createPlainFormClient(apiKey);
    const customerResult = await plain.upsertCustomer({
      identifier: { emailAddress: email },
      onCreate: {
        fullName: name,
        email: { email, isVerified: false },
      },
      // Public submissions must not overwrite an existing customer's profile.
      onUpdate: {},
    });
    if (customerResult.error || !customerResult.customer?.id) {
      throw new Error("Plain customer upsert failed", { cause: customerResult.error?.code });
    }

    operation = "createThread";
    const threadResult = await plain.createThread({
      customerIdentifier: { customerId: customerResult.customer.id },
      title: mode === "contact" ? "OpenWork contact message" : "OpenWork app feedback",
      threadFields: buildFeedbackThreadFields({ ...context, name, email, mode, submittedAt }),
      components: [
        { componentPlainText: { plainText: message } },
      ],
    });
    if (threadResult.error || !threadResult.thread?.id) {
      throw new Error("Plain thread creation failed", { cause: threadResult.error?.code });
    }
  } catch (error) {
    // Do not log API response bodies, which may contain submitted personal data.
    console.error("Plain form submission failed", {
      operation,
      errorType: error instanceof Error ? error.name : "UnknownError",
      code: error instanceof ForbiddenError ? "forbidden"
        : error instanceof Error && typeof error.cause === "string" ? error.cause : undefined,
      permissions: error instanceof ForbiddenError
        ? [...new Set(error.message.match(/\b[a-z][a-zA-Z]*:(?:read|create|edit|update|delete|search)\b/g) ?? [])]
        : undefined,
    });
    return jsonResponse(request, {
      error: "We couldn't send your message. Please try again or email team@openworklabs.com.",
    }, 502);
  }

  return jsonResponse(request, { ok: true });
}
