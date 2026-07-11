import catalogRepaired from "./assets/evidence/step-07-catalog-repaired.png"
import catalogTest from "./assets/evidence/step-05-catalog-test.png"
import cleanup from "./assets/evidence/step-09-cleanup.png"
import networkFailure from "./assets/evidence/step-02-network-failure.png"
import oauthCallback from "./assets/evidence/step-03-oauth-callback.png"
import oauthConnected from "./assets/evidence/step-04-oauth-connected.png"
import providerDenial from "./assets/evidence/step-08-provider-denial.png"
import setup from "./assets/evidence/step-01-setup.png"
import versionFault from "./assets/evidence/step-06-version-fault.png"
import type { EvidenceAssetName } from "./story"

export const evidenceAssets: Readonly<Record<EvidenceAssetName, string>> = {
  "step-01-setup.png": setup,
  "step-02-network-failure.png": networkFailure,
  "step-03-oauth-callback.png": oauthCallback,
  "step-04-oauth-connected.png": oauthConnected,
  "step-05-catalog-test.png": catalogTest,
  "step-06-version-fault.png": versionFault,
  "step-07-catalog-repaired.png": catalogRepaired,
  "step-08-provider-denial.png": providerDenial,
  "step-09-cleanup.png": cleanup,
}
