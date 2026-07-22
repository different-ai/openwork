type PosthogClient = {
  capture?: (event: string, properties?: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    posthog?: PosthogClient;
  }
}

export const POSTHOG_PROJECT_KEY = "phc_4YnPTlDVYPjgwKvLuNxhbHjV5kadgvd7XLzVHWnCXAI";

export function capturePosthogEvent(event: string, properties?: Record<string, unknown>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.posthog?.capture?.(event, properties);
  } catch {
    // Ignore analytics delivery failures.
  }
}
