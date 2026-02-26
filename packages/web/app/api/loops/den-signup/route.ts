import { NextRequest, NextResponse } from "next/server";

const LOOPS_CONTACTS_CREATE_URL = "https://app.loops.so/api/v1/contacts/create";
const SIGNUP_SOURCE = "openwork-den-web";

type SignupPayload = {
  email?: unknown;
  name?: unknown;
  userId?: unknown;
  authMethod?: unknown;
};

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function POST(request: NextRequest) {
  const loopsApiKey = process.env.LOOPS_API_KEY?.trim();
  if (!loopsApiKey) {
    return NextResponse.json({ ok: false, skipped: true, reason: "missing_loops_api_key" }, { status: 202 });
  }

  let payload: SignupPayload;
  try {
    payload = (await request.json()) as SignupPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  const email = asTrimmedString(payload.email);
  if (!email) {
    return NextResponse.json({ ok: false, error: "Email is required." }, { status: 400 });
  }

  const contactPayload: Record<string, string> = {
    email,
    source: SIGNUP_SOURCE
  };

  const name = asTrimmedString(payload.name);
  if (name) {
    contactPayload.firstName = name;
  }

  try {
    const response = await fetch(LOOPS_CONTACTS_CREATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${loopsApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(contactPayload),
      cache: "no-store"
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          skipped: true,
          reason: `loops_contact_create_failed_${response.status}`
        },
        { status: 202 }
      );
    }
  } catch {
    return NextResponse.json({ ok: false, skipped: true, reason: "loops_request_failed" }, { status: 202 });
  }

  return NextResponse.json({ ok: true });
}
