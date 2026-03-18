import { LandingEnterprise } from "../../components/landing-enterprise";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Enterprise",
  description: "Secure hosting for safe, permissioned AI employees."
};

export default async function Enterprise() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";

  return (
    <LandingEnterprise
      stars={github.stars}
      downloadHref={github.downloads.macos}
      calUrl={cal}
    />
  );
}
