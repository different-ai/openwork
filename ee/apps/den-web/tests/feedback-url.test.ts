import { describe, expect, test } from "bun:test";

import { buildDenFeedbackUrl, OPENWORK_FEEDBACK_URL } from "../app/(den)/_lib/feedback";

describe("Den feedback links", () => {
  test("point to the public landing feedback form with dashboard context", () => {
    const url = buildDenFeedbackUrl({
      pathname: "/dashboard/org-settings",
      orgSlug: "org_123",
      topic: "workspace-limits",
    });

    expect(url.startsWith(`${OPENWORK_FEEDBACK_URL}?`)).toBe(true);
    expect(url).toContain("source=openwork-web-app");
    expect(url).toContain("deployment=web");
    expect(url).toContain("entrypoint=%2Fdashboard%2Forg-settings");
    expect(url).toContain("org=org_123");
    expect(url).toContain("topic=workspace-limits");
  });
});
