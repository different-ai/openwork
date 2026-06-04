"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, Copy, Download, Github, Monitor, Puzzle, Store } from "lucide-react";
import {
  getGithubIntegrationRoute,
  getIntegrationsRoute,
  getMarketplacesRoute,
  getOrgDashboardRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useMarketplaces } from "./marketplace-data";

const ANTHROPIC_KNOWLEDGE_WORK_REPO = "https://github.com/anthropics/knowledge-work-plugins";
const OPENWORK_MCP_DOCS = "https://github.com/different-ai/openwork/blob/dev/docs/mcp-ui-control-profile.md";

export function MarketplaceOnboardingScreen() {
  const { activeOrg, orgSlug } = useOrgDashboard();
  const { data: marketplaces = [], isLoading } = useMarketplaces();

  return (
    <div className="mx-auto max-w-[1120px] px-4 pb-10 pt-4 sm:px-6 md:px-8">
      <section className="overflow-hidden rounded-[28px] border border-[#dfe5f0] bg-[#07192C] text-white shadow-sm">
        <div className="grid gap-8 p-6 md:grid-cols-[1.25fr_0.75fr] md:p-10">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.26em] text-cyan-200">OpenWork Cloud</p>
            <h1 className="mt-4 max-w-2xl text-[34px] font-semibold leading-[1.05] tracking-[-0.045em] md:text-[46px]">
              Your team extension hub is ready.
            </h1>
            <p className="mt-4 max-w-2xl text-[15px] leading-7 text-white/65">
              We created default marketplaces for {activeOrg?.name ?? "your organization"}. Marketplaces let you share
              extensions with your team: skills, agents, MCP servers, commands, hooks, and Anthropic-compatible plugins.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={getMarketplacesRoute(orgSlug)} className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-[13px] font-semibold text-[#07192C] transition hover:bg-white/90">
                View marketplaces <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href={getOrgDashboardRoute(orgSlug)} className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-white/10">
                Go to dashboard
              </Link>
            </div>
          </div>

          <div className="rounded-[22px] border border-white/10 bg-white/[0.06] p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300 text-[#07192C]">
                <Monitor className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[14px] font-semibold">Use them in desktop</p>
                <p className="mt-1 text-[12px] leading-5 text-white/55">Download OpenWork, then sign in with this same account.</p>
              </div>
            </div>
            <ol className="mt-5 grid gap-3 text-[13px] leading-6 text-white/70">
              <li className="flex gap-3"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-cyan-200" />Install OpenWork Desktop.</li>
              <li className="flex gap-3"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-cyan-200" />Sign in to OpenWork Cloud from Settings.</li>
              <li className="flex gap-3"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-cyan-200" />Open Marketplace to see built-ins and assigned team marketplaces.</li>
            </ol>
          </div>
        </div>
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        {(isLoading ? [] : marketplaces).map((marketplace) => (
          <Link
            key={marketplace.id}
            href={`${getMarketplacesRoute(orgSlug)}/${encodeURIComponent(marketplace.id)}`}
            className="rounded-[22px] border border-[#e2e7f0] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#cfd8e8] hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#EDF4FF] text-[#164B8F]">
                  <Store className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-[#07192C]">{marketplace.name}</h2>
                  <p className="mt-1 text-[12px] font-medium text-[#667695]">{marketplace.pluginCount} plugin{marketplace.pluginCount === 1 ? "" : "s"}</p>
                </div>
              </div>
              <ArrowRight className="mt-2 h-4 w-4 text-[#95A2BA]" />
            </div>
            {marketplace.description ? <p className="mt-4 text-[13px] leading-6 text-[#5C6B86]">{marketplace.description}</p> : null}
          </Link>
        ))}
        {isLoading ? (
          <div className="rounded-[22px] border border-[#e2e7f0] bg-white p-5 text-[13px] text-[#667695] shadow-sm">Loading your starter marketplaces...</div>
        ) : null}
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-[1fr_1fr_1fr]">
        <ActionCard
          icon={<Download className="h-5 w-5" />}
          title="Download, then sign in"
          body="The desktop app works without an account, but signing in unlocks OpenWork Marketplace and your organization marketplaces."
          href={getOrgDashboardRoute(orgSlug)}
          label="Open download panel"
        />
        <ActionCard
          icon={<Github className="h-5 w-5" />}
          title="Import an Anthropic-compatible repo"
          body="Use the starter Knowledge Work Plugins repo as the copy-paste example for plugin packaging and marketplace assignment."
          href={getGithubIntegrationRoute(orgSlug)}
          label="Open GitHub integration"
        />
        <ActionCard
          icon={<Puzzle className="h-5 w-5" />}
          title="Create more marketplaces"
          body="Connect an integration, package skills/agents/MCPs as plugins, then assign a marketplace to your org or specific users."
          href={getIntegrationsRoute(orgSlug)}
          label="Open integrations"
        />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[22px] border border-[#e2e7f0] bg-white p-6 shadow-sm">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#6C7890]">Anthropic-compatible starter</p>
          <h2 className="mt-2 text-[20px] font-semibold tracking-[-0.03em] text-[#07192C]">Use the Knowledge Work Plugins repo</h2>
          <p className="mt-3 text-[13px] leading-6 text-[#5C6B86]">
            The default Anthropic-compatible marketplace points to the same example repo used by OpenWork demo seeding. Import it from GitHub, review the discovered plugins, then add them to a marketplace for your team.
          </p>
          <a href={ANTHROPIC_KNOWLEDGE_WORK_REPO} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#d8e0ec] px-4 py-2.5 text-[13px] font-semibold text-[#07192C] transition hover:bg-[#f6f8fb]">
            Open anthropics/knowledge-work-plugins <ArrowRight className="h-4 w-4" />
          </a>
        </div>

        <div className="rounded-[22px] border border-[#d7e2f5] bg-[#F4F8FF] p-6 shadow-sm">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[#41618F]">Alternative: OpenWork MCP</p>
          <h2 className="mt-2 text-[20px] font-semibold tracking-[-0.03em] text-[#07192C]">Do it from your favorite AI app</h2>
          <p className="mt-3 text-[13px] leading-6 text-[#526582]">
            Install the OpenWork MCP, then ask your assistant to package and distribute extensions through OpenWork Cloud.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-2xl bg-[#07192C] p-4 text-[12px] leading-6 text-cyan-100"><code>{`{
  "mcpServers": {
    "openwork-ui": {
      "command": "npx",
      "args": ["-y", "openwork-ui-mcp"]
    }
  }
}`}</code></pre>
          <div className="mt-4 rounded-2xl border border-[#d7e2f5] bg-white p-4">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-[#41618F]"><Copy className="h-3.5 w-3.5" />Prompt to try</div>
            <p className="text-[13px] leading-6 text-[#07192C]">
              Package this skill as a plugin, put it on a marketplace, and assign it to my team.
            </p>
          </div>
          <a href={OPENWORK_MCP_DOCS} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-2 text-[13px] font-semibold text-[#164B8F] transition hover:text-[#0F376C]">
            Read OpenWork MCP docs <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </section>
    </div>
  );
}

function ActionCard({ icon, title, body, href, label }: {
  icon: React.ReactNode;
  title: string;
  body: string;
  href: string;
  label: string;
}) {
  return (
    <Link href={href} className="rounded-[22px] border border-[#e2e7f0] bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#cfd8e8] hover:shadow-md">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#07192C] text-white">{icon}</div>
      <h2 className="mt-4 text-[16px] font-semibold tracking-[-0.02em] text-[#07192C]">{title}</h2>
      <p className="mt-2 text-[13px] leading-6 text-[#5C6B86]">{body}</p>
      <div className="mt-4 inline-flex items-center gap-2 text-[13px] font-semibold text-[#164B8F]">
        {label} <ArrowRight className="h-4 w-4" />
      </div>
    </Link>
  );
}
