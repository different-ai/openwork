import fs from "fs";
import path from "path";
import { LandingBackground } from "./landing-background";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import { getGithubData } from "../lib/github";
import { renderMarkdown } from "../lib/render-markdown";

interface LegalPageProps {
  /** Path to the .md file relative to the app directory (e.g. "privacy/privacy-policy.md") */
  file: string;
}

/**
 * Full-page layout for legal pages. Reads a markdown file at build time
 * and renders it with nav, footer, and prose styling. No external dependencies.
 */
export async function LegalPage({ file }: LegalPageProps) {
  const github = await getGithubData();
  const callUrl = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  const raw = fs.readFileSync(
    path.join(process.cwd(), "app", file),
    "utf-8"
  );

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
          <article className="legal-prose max-w-4xl pt-6 md:pt-10">
            {renderMarkdown(raw)}
          </article>

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
