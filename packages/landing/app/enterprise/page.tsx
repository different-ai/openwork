import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { BookCallForm } from "../../components/book-call-form";
import { OpenCodeLogo } from "../../components/opencode-logo";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Enterprise",
  description: "Secure hosting for safe, permissioned AI employees."
};

export default async function Enterprise() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";

  return (
    <div className="min-h-screen">
      <SiteNav stars={github.stars} callUrl={cal} active="enterprise" />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              We help people host securely
            </div>
            <h1 className="mb-10 text-4xl font-bold tracking-tight">
              Create safe, permissioned AI employees.
            </h1>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            <div className="space-y-4 text-[15px] leading-relaxed text-gray-700">
              <p>
                OpenWork runs local-first. We help you deploy it in a way that matches your security posture,
                with clear permissions and reliable guardrails.
              </p>
              <p>
                The goal is simple: agents that can do real work, but only within the boundaries you define.
              </p>

              <div className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 bg-white px-5 py-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <OpenCodeLogo className="h-3 w-auto" />
                  <div>
                    <div className="text-[12px] font-bold uppercase tracking-wider text-gray-500">
                      Built on OpenCode
                    </div>
                    <div className="text-[13px] text-gray-600">
                      Compatible with OpenCode tooling.
                    </div>
                  </div>
                </div>
                <a
                  href="https://opencode.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] font-semibold text-gray-500 transition hover:text-black"
                >
                  opencode.ai
                </a>
              </div>

              <div className="rounded-xl border border-gray-100 bg-gray-50 p-6">
                <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
                  What we focus on
                </div>
                <div className="grid grid-cols-1 gap-2 text-[13px] text-gray-600 sm:grid-cols-2">
                  <div>Secure hosting</div>
                  <div>Permissioned tools</div>
                  <div>Auditability</div>
                  <div>Team rollout</div>
                </div>
              </div>

              <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
                <div className="mb-2 text-[12px] font-bold uppercase tracking-wider text-gray-500">
                  New
                </div>
                <h3 className="mb-2 text-[18px] font-bold">Den preorder</h3>
                <p className="mb-4 text-[13px] leading-relaxed text-gray-600">
                  $1 first month, then $50/month per worker. Cancel anytime.
                  Includes priority onboarding and custom workflows.
                </p>
                <a href="/den" className="doc-button">
                  View Den
                </a>
              </div>
            </div>

            <BookCallForm calUrl={cal} />
          </div>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
