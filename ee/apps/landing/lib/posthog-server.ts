import { POSTHOG_PROJECT_KEY } from "./posthog-client";

const POSTHOG_SERVER_TIMEOUT_MS = 400;

export async function capturePosthogServerEvent(event: string, properties: Record<string, unknown>): Promise<void> {
  if (process.env.VERCEL_ENV !== "production" && !process.env.LANDING_POSTHOG_HOST) {
    return;
  }

  const host = process.env.LANDING_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POSTHOG_SERVER_TIMEOUT_MS);

  try {
    await fetch(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: POSTHOG_PROJECT_KEY,
        event,
        // Random per-event ID plus disabled person processing keeps captures anonymous and unlinkable.
        distinct_id: crypto.randomUUID(),
        properties: { ...properties, $process_person_profile: false }
      })
    });
  } catch {
    // Ignore analytics delivery failures.
  } finally {
    clearTimeout(timeout);
  }
}
