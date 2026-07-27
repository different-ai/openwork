import { MarketplaceOnboardingScreen } from "../../_components/marketplace-onboarding-screen";
import { getPublicInstallers } from "../../../_lib/public-installers";

export default async function MarketplaceOnboardingPage() {
  const { installers, releaseTag } = await getPublicInstallers();
  return <MarketplaceOnboardingScreen installers={installers} releaseTag={releaseTag} />;
}
