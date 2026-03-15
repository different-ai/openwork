import { LandingEnterprise } from "../../components/landing-enterprise";
import { resolveDownloadHref } from "../../lib/download-target";
import { getGithubData } from "../../lib/github";
import { headers } from "next/headers";

export const metadata = {
  title: "OpenWork — Enterprise",
  description: "Secure hosting for safe, permissioned AI employees."
};

export default async function Enterprise() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";
  const downloadHref = resolveDownloadHref(github, headers());

  return (
    <LandingEnterprise
      stars={github.stars}
      downloadHref={downloadHref}
      calUrl={cal}
    />
  );
}
