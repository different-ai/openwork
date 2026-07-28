export const OPENWORK_FEEDBACK_URL = "https://openworklabs.com/feedback";

export function buildDenFeedbackUrl(options?: {
  pathname?: string;
  orgSlug?: string | null;
  topic?: string;
}) {
  const params = new URLSearchParams({
    source: "openwork-web-app",
    deployment: "web",
    entrypoint: options?.pathname ?? "dashboard"
  });

  if (options?.orgSlug) {
    params.set("org", options.orgSlug);
  }

  if (options?.topic) {
    params.set("topic", options.topic);
  }

  return `${OPENWORK_FEEDBACK_URL}?${params.toString()}`;
}
