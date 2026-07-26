import { describe, expect, test } from "bun:test";

import { t } from "../src/i18n";
import { skillOriginBadgeLabel } from "../src/react-app/domains/session/surface/composer/capability-origin";

describe("composer capability origin badges", () => {
  test("labels organization skills with their marketplace and local skills as local", () => {
    expect(skillOriginBadgeLabel({ origin: "openwork-connect", marketplaceName: "Team tools" })).toBe("Team tools");
    expect(skillOriginBadgeLabel({ origin: "local" })).toBe(t("composer.source_local"));
  });
});
