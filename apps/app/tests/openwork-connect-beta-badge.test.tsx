import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { t } from "../src/i18n";
import { ExtensionCard } from "../src/react-app/design-system/extension-card";
import { SettingsBetaBadge } from "../src/react-app/domains/settings/shell/settings-page";

describe("OpenWork Connect beta label", () => {
  test("renders the client navigation, pitch, and connection card as beta", () => {
    const badge = renderToStaticMarkup(<SettingsBetaBadge />);
    const card = renderToStaticMarkup(
      <ExtensionCard name="Team connection" description="Shared through OpenWork Connect" beta />,
    );

    expect(badge).toContain(">Beta<");
    expect(badge).not.toContain("Alpha");
    expect(card).toContain(">Beta<");
    expect(card).not.toContain("Alpha");
    expect(t("connect.pitch_body")).toContain("Connect (beta)");
  });
});
