import { LandingHome } from "../components/landing-home";
import { getGithubData } from "../lib/github";
import { resolveDownloadHref } from "../lib/download-target";
import { headers } from "next/headers";

export default async function Home() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";
  const requestHeaders = headers();
  const userAgent = requestHeaders.get("user-agent")?.toLowerCase() || "";
  const isMobileVisitor = /android|iphone|ipad|ipod|mobile/.test(userAgent);
  const downloadHref = resolveDownloadHref(github, requestHeaders);

  return (
    <LandingHome
      stars={github.stars}
      downloadHref={downloadHref}
      callHref={cal}
      isMobileVisitor={isMobileVisitor}
    />
  );
}
