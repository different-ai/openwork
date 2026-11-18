import type { FeatureIntro, FeatureIntroKey } from "../types";
import { aiGatewayIntros } from "./ai-gateway";
import { analyticsIntros } from "./analytics";
import { auditLogsIntros } from "./audit-logs";
import { authSecurityIntros } from "./auth-security";
import { connectorsIntros } from "./connectors";
import { automationsIntros } from "./automations";
import { homeIntros } from "./home";
import { libraryIntros } from "./library";
import { membersIntros } from "./members";
import { pluginsIntros } from "./plugins";
import { teamDetailIntros } from "./team-detail";
import { workbotIntros } from "./workbot";
import { apiKeysIntros } from "./api-keys";
import { collectionsIntros } from "./collections";
import { deploymentsIntros } from "./deployments";
import { computersIntros } from "./computers";
import { settingsIntros } from "./settings";
import { toolTesterIntros } from "./tool-tester";

/**
 * The feature intro registry (DESIGN.md I10). One file per section
 * (e.g. `./ai-gateway.tsx` exporting `aiGatewayIntros`), spread in here.
 */
export const FEATURE_INTROS: readonly FeatureIntro[] = [
  ...aiGatewayIntros,
  ...analyticsIntros,
  ...auditLogsIntros,
  ...authSecurityIntros,
  ...connectorsIntros,
  ...automationsIntros,
  ...homeIntros,
  ...libraryIntros,
  ...membersIntros,
  ...pluginsIntros,
  ...teamDetailIntros,
  ...workbotIntros,
  ...apiKeysIntros,
  ...collectionsIntros,
  ...deploymentsIntros,
  ...computersIntros,
  ...settingsIntros,
  ...toolTesterIntros,
];

export function getFeatureIntro(key: FeatureIntroKey): FeatureIntro | null {
  return FEATURE_INTROS.find((intro) => intro.key === key) ?? null;
}
