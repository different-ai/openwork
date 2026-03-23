import { buildResponseHeaders, jsonResponse, rateLimitFormRequest, validateAntiSpamFields, validateTrustedOrigin, verifyFormBotProtection } from "../_lib/security";

type ContactPayload = {
  fullName?: string;
  companyEmail?: string;
  message?: string;
  website?: string;
  startedAt?: number | string;
};

const LOOPS_CONTACTS_API_URL = "https://app.loops.so/api/v1/contacts/update";
const LOOPS_EVENTS_API_URL = "https://app.loops.so/api/v1/events/send";
const ENTERPRISE_EVENT_NAME = "enterpriseContactSubmitted";
const ENTERPRISE_SOURCE = "OpenWork Enterprise Contact Form";
const ENTERPRISE_GROUP = "Enterprise Leads";

function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { firstName: "", lastName: "" };
  }

  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" ")
  };
}

function validatePayload(payload: ContactPayload) {
  const fullName = payload.fullName?.trim() ?? "";
  const companyEmail = payload.companyEmail?.trim() ?? "";
  const message = payload.message?.trim() ?? "";

  if (!fullName || !companyEmail || !message) {
    return { error: "Please fill out all fields." };
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(companyEmail)) {
    return { error: "Please enter a valid work email." };
  }

  return {
    fullName,
    companyEmail,
    message
  };
}

function deriveCompanyFromEmail(email: string) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) {
    return "";
  }

  const parts = domain.split(".").filter(Boolean);
  if (parts.length === 0) {
    return "";
  }

  const compoundSuffixes = new Set([
    "co.uk",
    "com.au",
    "co.jp",
    "com.br",
    "co.in",
    "com.sg",
    "com.mx",
    "com.tr"
  ]);

  const suffix = parts.slice(-2).join(".");
  const baseIndex =
    parts.length >= 3 && compoundSuffixes.has(suffix)
      ? parts.length - 3
      : parts.length - 2;
  const companySlug = parts[Math.max(baseIndex, 0)] ?? "";

  return companySlug
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function POST(request: Request) {
  const originCheck = validateTrustedOrigin(request);
  if (!originCheck.ok) {
    return jsonResponse(request, { error: originCheck.error }, originCheck.status);
  }

  const rateLimit = rateLimitFormRequest(request, "enterprise-contact");
  if (!rateLimit.ok) {
    return new Response(JSON.stringify({ error: "Contact form is temporarily rate limited." }), {
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
  if (!apiKey) {
    return jsonResponse(request,
      { error: "Loops is not configured on this deployment." },
      500
    );
  }

  let payload: ContactPayload;
  try {
    const raw = await request.text();
    if (raw.length > 6000) {
      return jsonResponse(request, { error: "Request payload is too large." }, 413);
    }
    payload = JSON.parse(raw) as ContactPayload;
  } catch {
    return jsonResponse(request,
      { error: "Invalid request payload." },
      400
    );
  }

  const antiSpam = validateAntiSpamFields(payload);
  if (!antiSpam.ok) {
    return jsonResponse(request, { error: antiSpam.error }, antiSpam.status);
  }

  const validated = validatePayload(payload);
  if ("error" in validated) {
    return jsonResponse(request, { error: validated.error }, 400);
  }

  const { firstName, lastName } = splitName(validated.fullName);
  const company = deriveCompanyFromEmail(validated.companyEmail);
  const submittedAt = new Date().toISOString();

  const contactResponse = await fetch(LOOPS_CONTACTS_API_URL, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email: validated.companyEmail,
      firstName,
      lastName: lastName || undefined,
      company: company || undefined,
      notes: validated.message,
      source: ENTERPRISE_SOURCE,
      userGroup: ENTERPRISE_GROUP
    }),
    cache: "no-store"
  });

  if (!contactResponse.ok) {
    let detail = "Failed to submit contact request.";

    try {
      const errorData = (await contactResponse.json()) as { message?: string };
      if (errorData.message?.trim()) {
        detail = errorData.message;
      }
    } catch {
      // Ignore invalid error payloads from upstream and return a generic message.
    }

    return jsonResponse(request, { error: detail }, 502);
  }

  const eventResponse = await fetch(LOOPS_EVENTS_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email: validated.companyEmail,
      eventName: ENTERPRISE_EVENT_NAME,
      firstName,
      lastName: lastName || undefined,
      source: ENTERPRISE_SOURCE,
      userGroup: ENTERPRISE_GROUP,
      eventProperties: {
        message: validated.message,
        fullName: validated.fullName,
        submittedAt,
        page: "enterprise",
        note: validated.message
      }
    }),
    cache: "no-store"
  });

  if (!eventResponse.ok) {
    let detail = "Failed to record contact event.";

    try {
      const errorData = (await eventResponse.json()) as { message?: string };
      if (errorData.message?.trim()) {
        detail = errorData.message;
      }
    } catch {
      // Ignore invalid error payloads from upstream and return a generic message.
    }

    return jsonResponse(request, { error: detail }, 502);
  }

  return jsonResponse(request, { ok: true });
}
