import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnablementResult } from "../src/app/extensions";
import { ExtensionCard } from "../src/react-app/design-system/extension-card";
import { warningBannerClass } from "../src/react-app/domains/workspace/modal-styles";

describe("desktop neutral state surfaces", () => {
  test("uses a neutral shell for partial extension readiness", () => {
    const condition = (label: string, met: boolean): EnablementResult => ({
      condition: { type: "mcp-connected", ref: label, label },
      met,
    });
    const markup = renderToStaticMarkup(
      <ExtensionCard
        name="Connection"
        description="Connection readiness"
        enablement={[condition("Configured", true), condition("Signed in", false)]}
      />,
    );

    expect(markup).toContain("border-dls-border");
    expect(markup).toContain("bg-dls-hover");
    expect(markup).toContain("Partially set up");
    expect(markup).not.toContain("border-amber-6 bg-amber-2");
  });

  test("uses the neutral warning banner primitive", () => {
    expect(warningBannerClass).toContain("border-dls-border");
    expect(warningBannerClass).toContain("bg-dls-hover");
    expect(warningBannerClass).not.toContain("border-amber");
    expect(warningBannerClass).not.toContain("bg-amber");
  });
});
