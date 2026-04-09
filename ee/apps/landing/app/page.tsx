import { LandingHome } from "../components/landing-home";
import { getGithubData } from "../lib/github";
import { headers } from "next/headers";

export default async function Home() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";
  const windowsCheckoutUrl =
    process.env.NEXT_PUBLIC_WINDOWS_CHECKOUT_URL || "/download#windows-support";
  const userAgent = headers().get("user-agent")?.toLowerCase() || "";
  const isMobileVisitor = /android|iphone|ipad|ipod|mobile/.test(userAgent);

  return (
    <LandingHome
      stars={github.stars}
      downloadHref={github.downloads.macos}
      callHref={cal}
      windowsCheckoutUrl={windowsCheckoutUrl}
      isMobileVisitor={isMobileVisitor}
    />
  );
}
