export const MICX_FEEDBACK_URL = "https://micxlabs.com/feedback";

export function buildDenFeedbackUrl(options?: {
  pathname?: string;
  orgSlug?: string | null;
  topic?: string;
}) {
  const params = new URLSearchParams({
    source: "micx-web-app",
    deployment: "web",
    entrypoint: options?.pathname ?? "dashboard"
  });

  if (options?.orgSlug) {
    params.set("org", options.orgSlug);
  }

  if (options?.topic) {
    params.set("topic", options.topic);
  }

  return `${MICX_FEEDBACK_URL}?${params.toString()}`;
}
