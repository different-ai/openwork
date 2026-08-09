import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ExtensionDetailModal } from "../src/react-app/design-system/extension-detail-modal";

describe("ExtensionDetailModal connection errors", () => {
  test("keeps the connection detail visible and shows the failed OAuth attempt", () => {
    const html = renderToStaticMarkup(
      <ExtensionDetailModal
        open
        presentation="page"
        onClose={() => {}}
        name="BigQuery"
        description="Connect BigQuery to your organization."
        taxonomy="connection"
        oauth
        errorInfo="Sign-in did not complete. Check the provider window for an OAuth error."
        onConnect={() => {}}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Sign-in did not complete");
    expect(html).toContain("Connect");
  });
});
