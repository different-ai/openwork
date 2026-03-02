import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { OpenCodeLogo } from "../../components/opencode-logo";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Den",
  description:
    "Hosted sandboxed workers for your team, available in desktop, Slack, and Telegram.",
};

export default async function Den() {
  const github = await getGithubData();

  return (
    <div className="min-h-screen">
      <SiteNav stars={github.stars} active="den" />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              OpenWork hosted
            </div>
            <h1 className="mb-3 text-4xl font-bold tracking-tight">Den</h1>
            <h2 className="mb-8 text-[34px] font-bold leading-tight tracking-tight text-black">
              Hosted sandboxed workers for your team
            </h2>
            <p className="max-w-3xl text-[18px] leading-relaxed text-gray-600">
              Den gives your team hosted sandboxed workers that you can access
              from our desktop app, Slack, or Telegram. All your skills,
              agents, and MCP integrations are directly available.
            </p>
          </div>

          <div className="mb-12 mt-10 flex flex-wrap items-center gap-3">
            <a
              href="https://app.openwork.software"
              className="doc-button"
              rel="noreferrer"
              target="_blank"
            >
              Get started
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </a>
          </div>

          <div className="mb-8 text-[20px] font-semibold text-black">
            $50/month per worker. Cancel anytime.
          </div>
          <p className="mb-12 max-w-3xl text-[15px] leading-relaxed text-gray-600">
            Early adopters get priority onboarding and custom workflow setup
            through March 1.
          </p>

          <div className="mb-14 grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
            <div className="feature-card">
              <h4 className="mb-2 text-[14px] font-bold">
                Hosted sandboxed workers
              </h4>
              <p className="text-[13px] leading-relaxed text-gray-500">
                Every worker runs in an isolated environment so your team can
                automate safely without managing infrastructure.
              </p>
            </div>
            <div className="feature-card">
              <h4 className="mb-2 text-[14px] font-bold">
                Desktop, Slack, and Telegram access
              </h4>
              <p className="text-[13px] leading-relaxed text-gray-500">
                Run and monitor the same workers from the OpenWork desktop app
                or directly inside your team chats.
              </p>
            </div>
            <div className="feature-card">
              <h4 className="mb-2 text-[14px] font-bold">
                Skills, agents, and MCP included
              </h4>
              <p className="text-[13px] leading-relaxed text-gray-500">
                Bring your existing OpenWork setup and everything is available
                immediately in each hosted worker.
              </p>
            </div>
          </div>

          <div className="mb-16 flex flex-wrap items-center gap-2 text-[13px] text-gray-500">
            <span className="font-semibold text-gray-900">Powered by</span>
            <a
              href="https://opencode.ai"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center"
              aria-label="opencode.ai"
            >
              <OpenCodeLogo className="h-3 w-auto" />
            </a>
            <span>Everything from opencode just works.</span>
          </div>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
