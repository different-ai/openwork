import { CheckCircle2 } from "lucide-react";

import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
};

// The one action on this page. The agent guide it points to lives in
// packages/openwork-bootstrap/migrate.md and is served at /migrate.md.
export const MIGRATION_PROMPT =
  "Follow https://openworklabs.com/migrate.md to move my Claude plugins and skills to OpenWork.";

const moves = [
  ["Plugins you added in Cowork or Claude Code", "Imported into your OpenWork organization from their GitHub marketplace, such as Anthropic's knowledge-work-plugins. Their skills work right away."],
  ["Skills you wrote yourself", "Uploaded as private skills only you can use until you share them."],
  ["Connectors a plugin suggests", "Added as optional. Each person connects the services they use, such as Slack or Google Workspace."],
  ["Running it again", "Picks up changes from the marketplace and from your own skills. Nothing is duplicated."]
];

const stays = [
  "Conversation history and saved credentials.",
  "Plugins that are not in a public GitHub repository.",
  "Scheduled tasks: recreate each one and run it once by hand."
];

const manualSteps = [
  ["Install the OpenWork command", "curl -fsSLo /tmp/openwork-install.sh https://openworklabs.com/install.sh && sh /tmp/openwork-install.sh"],
  ["Sign in", "openwork-bootstrap login"],
  ["See what will move", "openwork-bootstrap migrate plan"],
  ["Move the plugins you use", "openwork-bootstrap migrate apply --plugin productivity,sales"]
];

const checklist = [
  "Each skill you rely on runs on a real task in OpenWork.",
  "The connectors those skills need are connected.",
  "At least one model is set up and you know how it is billed.",
  "Scheduled tasks are recreated and have run once."
];

export function MigrationGuidePage({ stars, downloadHref }: Props) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={stars} active="docs" />

      <main className="mx-auto w-full max-w-[1040px] px-6 pb-8">
        <header className="border-b border-[var(--lp-border)] pb-14 pt-16 md:pb-20 md:pt-[88px]">
          <div className="text-[15px] text-[var(--lp-muted)]">Migration guide</div>
          <h1 className="mt-5 max-w-[820px] text-[44px] font-light leading-[49px] tracking-[-0.02em] md:text-[58px] md:leading-[62px]">
            Move from Claude Cowork with one prompt.
          </h1>
          <p className="mt-7 max-w-[720px] text-[18px] leading-[29px] text-[var(--lp-body)]">
            Paste this into Claude Code, or any agent that can run commands on your
            computer. It finds your plugins and the skills you wrote, shows you what
            will move, and imports what you choose into OpenWork.
          </p>
          <pre className="mt-8 max-w-[820px] overflow-x-auto whitespace-pre-wrap rounded-[16px] bg-[#011627] p-5 font-mono text-[14px] leading-6 text-white">
            <code>{MIGRATION_PROMPT}</code>
          </pre>
          <p className="mt-4 max-w-[720px] text-[14px] leading-[22px] text-[var(--lp-muted)]">
            You need an owner or admin account in your OpenWork organization to share
            plugins with everyone. The agent asks before it uploads anything.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a href="/migrate.md" className="lp-pill-primary">
              Read what the agent will do
            </a>
            <a href={downloadHref} className="lp-pill-secondary">
              Download OpenWork
            </a>
          </div>
        </header>

        <section className="py-14 md:py-20">
          <div className="text-[15px] text-[var(--lp-muted)]">What moves</div>
          <h2 className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em] md:text-[42px] md:leading-[48px]">
            Your plugins and skills, ready to use.
          </h2>
          <div className="mt-9 grid gap-4 md:grid-cols-2">
            {moves.map(([title, body]) => (
              <div key={title} className="rounded-[20px] bg-[var(--lp-tonal)] p-6">
                <h3 className="text-[16px] font-semibold">{title}</h3>
                <p className="mt-2 text-[14px] leading-[22px] text-[var(--lp-body)]">{body}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-[14px] bg-[#fff7ed] p-4 text-[13.5px] leading-[22px] text-[#7c2d12]">
            <div className="font-semibold">What stays behind</div>
            <ul className="mt-1 list-disc pl-5">
              {stays.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        </section>

        <section className="border-t border-[var(--lp-border)] py-14 md:py-20">
          <div className="grid gap-12 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div>
              <div className="text-[15px] text-[var(--lp-muted)]">Without an agent</div>
              <h2 className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em]">
                The same move, by hand.
              </h2>
            </div>
            <div className="divide-y divide-[var(--lp-border)] border-y border-[var(--lp-border)]">
              {manualSteps.map(([title, command], index) => (
                <article key={title} className="grid gap-3 py-6 sm:grid-cols-[44px_minmax(0,1fr)]">
                  <div className="font-pixel text-[24px] text-[var(--lp-faint)]">{String(index + 1).padStart(2, "0")}</div>
                  <div className="min-w-0">
                    <h3 className="text-[17px] font-semibold">{title}</h3>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-[10px] bg-[var(--lp-tonal)] px-3 py-2 font-mono text-[13px] leading-[21px]">
                      <code>{command}</code>
                    </pre>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-[24px] bg-[var(--lp-tonal)] p-7 md:p-12">
          <h2 className="max-w-[620px] text-[34px] font-light leading-[41px] tracking-[-0.015em]">
            Switch once your real work runs.
          </h2>
          <div className="mt-6 flex flex-col gap-4">
            {checklist.map((item) => (
              <div key={item} className="flex gap-3 text-[14px] leading-[22px]">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.6} />
                <span>{item}</span>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-[650px] text-[14px] leading-[22px] text-[var(--lp-body)]">
            Need more detail? See{" "}
            <a href="/docs/start-here/connect-your-stack/connect-services" className="underline underline-offset-4">connecting your services</a>{" "}
            and the{" "}
            <a href="/docs/cloud/team-quickstart" className="underline underline-offset-4">team quickstart</a>.
          </p>
        </section>

        <div className="mt-16">
          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
