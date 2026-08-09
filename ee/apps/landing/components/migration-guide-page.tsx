import { CheckCircle2 } from "lucide-react";

import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
};

const carryOvers = [
  ["Files and folders", "Open the same folder or repository as an OpenWork workspace."],
  ["SKILL.md skills", "Copy the skill folder or install the plugin that contains it."],
  ["Claude-compatible plugins", "Import the manifest; OpenWork normalizes its skills and MCP dependencies."],
  ["MCP servers", "Reconnect through OpenWork Connect or add the server URL as a custom app."],
  ["Claude models", "Add an Anthropic API key or provision Anthropic through OpenWork Cloud."],
  ["Scheduled tasks", "Recreate each schedule, then verify its workspace, permissions, and output."]
];

const checklist = [
  "The same workspace opens and the agent can read the expected files.",
  "At least one model is connected and its billing is understood.",
  "Each required skill triggers on a representative task.",
  "Each connector or MCP server is authorized and tested.",
  "Scheduled and browser tasks have been run manually once.",
  "Important Cowork instructions are saved in files or skills."
];

export function MigrationGuidePage({ stars, downloadHref }: Props) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={stars} downloadHref={downloadHref} active="docs" />

      <main className="mx-auto w-full max-w-[1040px] px-6 pb-8">
        <header className="border-b border-[var(--lp-border)] pb-14 pt-16 md:pb-20 md:pt-[88px]">
          <div className="text-[15px] text-[var(--lp-muted)]">Migration guide</div>
          <h1 className="mt-5 max-w-[820px] text-[44px] font-light leading-[49px] tracking-[-0.02em] md:text-[58px] md:leading-[62px]">
            Move from Claude Cowork without rebuilding your setup.
          </h1>
          <p className="mt-7 max-w-[720px] text-[18px] leading-[29px] text-[var(--lp-body)]">
            Start with one real task, bring over the capabilities it needs, and
            keep Cowork available until that task works end to end in OpenWork.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a href={downloadHref} className="lp-pill-primary">
              Download OpenWork
            </a>
            <a href="/docs/start-here/get-started" className="lp-pill-secondary">
              Open the getting-started guide
            </a>
          </div>
        </header>

        <section className="py-14 md:py-20">
          <div className="text-[15px] text-[var(--lp-muted)]">What carries over</div>
          <h2 className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em] md:text-[42px] md:leading-[48px]">
            Keep the work. Reconnect the access.
          </h2>
          <div className="mt-9 grid gap-4 md:grid-cols-2">
            {carryOvers.map(([title, body]) => (
              <div key={title} className="rounded-[20px] bg-[var(--lp-tonal)] p-6">
                <h3 className="text-[16px] font-semibold">{title}</h3>
                <p className="mt-2 text-[14px] leading-[22px] text-[var(--lp-body)]">{body}</p>
              </div>
            ))}
          </div>
          <p className="mt-5 rounded-[14px] bg-[#fff7ed] p-4 text-[13.5px] leading-[22px] text-[#7c2d12]">
            Conversation history and credentials do not transfer automatically.
            Save important instructions in workspace files or skills, then authorize
            each connected service in OpenWork.
          </p>
        </section>

        <section className="border-t border-[var(--lp-border)] py-14 md:py-20">
          <div className="grid gap-12 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div>
              <div className="text-[15px] text-[var(--lp-muted)]">Migration path</div>
              <h2 className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em]">
                One workflow at a time.
              </h2>
            </div>
            <div className="divide-y divide-[var(--lp-border)] border-y border-[var(--lp-border)]">
              <GuideStep number="01" title="Open the same work">
                Install OpenWork, create a workspace from the folder or repository
                you used with Cowork, and ask the agent to summarize it before making
                changes.
              </GuideStep>
              <GuideStep number="02" title="Choose your models">
                Keep Claude with an Anthropic API key, add another provider, or let
                your organization provision models centrally. Your Claude subscription
                and Anthropic API billing may be separate.
              </GuideStep>
              <GuideStep number="03" title="Bring over skills and plugins">
                OpenWork uses the same SKILL.md format. Import one skill at a time,
                check its paths and environment variables, then run the smallest task
                that should trigger it.
              </GuideStep>
              <GuideStep number="04" title="Reconnect apps and MCP servers">
                Reauthorize every service. Test read-only actions first, then test
                write actions with a disposable example.
              </GuideStep>
              <GuideStep number="05" title="Recreate schedules and browser tasks">
                Record each prompt, schedule, time zone, workspace, connection, and
                output location. Run it manually once before enabling recurrence.
              </GuideStep>
              <GuideStep number="06" title="Roll it out without configuration drift">
                Use OpenWork Cloud to publish approved capabilities once, assign them
                by team, and apply desktop policies centrally instead of repeating
                setup on every machine.
              </GuideStep>
            </div>
          </div>
        </section>

        <section className="border-t border-[var(--lp-border)] py-14 md:py-20">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <div className="text-[15px] text-[var(--lp-muted)]">Useful guides</div>
              <h2 className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em]">
                Configure each piece.
              </h2>
              <div className="mt-7 flex flex-col items-start gap-3 text-[15px]">
                <GuideLink href="/docs/start-here/connect-your-stack/add-anthropic-api-key">Add an Anthropic API key</GuideLink>
                <GuideLink href="/docs/start-here/do-work-with-it/skills-plugins-and-mcp">Connectors, skills, and plugins</GuideLink>
                <GuideLink href="/docs/start-here/connect-your-stack/connect-services">Connect your services</GuideLink>
                <GuideLink href="/docs/start-here/connect-your-stack/add-an-mcp-server">Add a custom MCP server</GuideLink>
                <GuideLink href="/docs/cloud/team-quickstart">OpenWork Cloud team quickstart</GuideLink>
              </div>
            </div>
            <div className="rounded-[24px] bg-[var(--lp-tonal)] p-7 md:p-9">
              <div className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--lp-muted)]">
                Cutover checklist
              </div>
              <div className="mt-6 flex flex-col gap-4">
                {checklist.map((item) => (
                  <div key={item} className="flex gap-3 text-[14px] leading-[22px]">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.6} />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-[24px] bg-[var(--lp-tonal)] p-7 md:p-12">
          <h2 className="max-w-[620px] text-[34px] font-light leading-[41px] tracking-[-0.015em]">
            Make OpenWork the default only after the real workflow passes.
          </h2>
          <p className="mt-4 max-w-[650px] text-[15px] leading-6 text-[var(--lp-body)]">
            Keep Cowork available during validation. Once the checklist passes,
            switch that workflow and migrate the next one.
          </p>
          <a href={downloadHref} className="lp-pill-primary mt-7">
            Download OpenWork
          </a>
        </section>

        <div className="mt-16">
          <SiteFooter />
        </div>
      </main>
    </div>
  );
}

function GuideStep({
  number,
  title,
  children
}: {
  number: string;
  title: string;
  children: string;
}) {
  return (
    <article className="grid gap-3 py-6 sm:grid-cols-[44px_minmax(0,1fr)]">
      <div className="font-pixel text-[24px] text-[var(--lp-faint)]">{number}</div>
      <div>
        <h3 className="text-[17px] font-semibold">{title}</h3>
        <p className="mt-2 text-[14.5px] leading-[23px] text-[var(--lp-body)]">{children}</p>
      </div>
    </article>
  );
}

function GuideLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="font-medium underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]">
      {children} →
    </a>
  );
}
