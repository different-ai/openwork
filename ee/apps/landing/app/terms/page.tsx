import fs from "fs";
import path from "path";
import { LandingBackground } from "../../components/landing-background";
import { LegalPage } from "../../components/legal-page";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";
import { parseLegalDoc, renderBlocks } from "../../lib/parse-legal-doc";

export const metadata = {
  title: "OpenWork — Terms of Use",
  description:
    "Terms of use for Different AI, doing business as OpenWork."
};

export default async function TermsPage() {
  const github = await getGithubData();
  const callUrl = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  const raw = fs.readFileSync(
    path.join(process.cwd(), "app/terms/terms-of-use.txt"),
    "utf-8"
  );
  const doc = parseLegalDoc(raw);

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={github.stars}
            callUrl={callUrl}
            downloadHref={github.downloads.macos}
          />
        </div>

        <main className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <LegalPage title={doc.title} effectiveDate={doc.effectiveDate}>
            {renderBlocks(doc.blocks)}
          </LegalPage>

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
