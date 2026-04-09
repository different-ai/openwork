export const OPENWORK_FEEDBACK_URL = "https://openworklabs.com/feedback";

export function buildDenFeedbackUrl(options?: {
  pathname?: string;
  orgSlug?: string | null;
  topic?: string;
}) {
  const url = new URL(OPENWORK_FEEDBACK_URL);
  url.searchParams.set("source", "openwork-web-app");
  url.searchParams.set("deployment", "web");
  url.searchParams.set("entrypoint", options?.pathname ?? "dashboard");

  if (options?.orgSlug) {
    url.searchParams.set("org", options.orgSlug);
  }

  if (options?.topic) {
    url.searchParams.set("topic", options.topic);
  }

  return url.toString();
}
