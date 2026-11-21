import type { CaptureResult, Properties } from "posthog-js";

const URL_PROPERTIES = [
  "$current_url", "$initial_current_url", "$referrer", "$initial_referrer",
  "$session_entry_url", "$session_exit_url", "$session_entry_referrer",
];

function scrubUrls(properties: Properties): Properties {
  const cleaned = { ...properties };
  for (const key of URL_PROPERTIES) {
    const value = cleaned[key];
    if (typeof value !== "string" || value === "$direct") continue;
    try {
      const url = new URL(value, "https://app.openworklabs.com");
      cleaned[key] = url.protocol === "https:" || url.protocol === "http:"
        ? `${url.origin}${url.pathname}`
        : "[redacted URL]";
    } catch {
      cleaned[key] = "[redacted URL]";
    }
  }
  return cleaned;
}

function scrubPerson(properties: Properties): Properties {
  const { email, name, ...rest } = properties;
  return scrubUrls(rest);
}

export function beforeSendPosthog(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null;
  try {
    const properties = scrubPerson(event.properties);
    for (const key of ["$set", "$set_once"]) {
      if (properties[key] && typeof properties[key] === "object") {
        properties[key] = scrubPerson(properties[key]);
      }
    }
    return {
      ...event,
      properties,
      ...(event.$set ? { $set: scrubPerson(event.$set) } : {}),
      ...(event.$set_once ? { $set_once: scrubPerson(event.$set_once) } : {}),
    };
  } catch {
    return null;
  }
}
