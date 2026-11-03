import Link from "next/link";
import { GovernanceFaq, GovernanceNextSteps, GovernanceSection, ModelTrafficPath } from "../../components/governance-primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";
import { shadowAiFaq } from "../../lib/shadow-ai";

export const metadata = withSocialMetadata({
  title: "Shadow AI governance — Manage shadow AI with OpenWork",
  description: "Manage shadow AI with a practical governance framework, AI usage policy, and approved AI gateway. Company SSO, AWS Bedrock, permissions, and local-first work.",
  alternates: { canonical: "/shadow-ai" },
  openGraph: { url: "https://openworklabs.com/shadow-ai" }
});

export default async function ShadowAiPage() {
  const github = await getGithubData();
  return <div className="min-h-screen bg-[var(--lp-page)] text-[var(--lp-ink)]">
    <SiteNav stars={github.stars} />
    <main id="main-content" className="mx-auto w-full max-w-[1176px] px-6 pb-8">
      <section className="governance-hero">
        <p className="governance-label">Shadow AI governance</p>
        <h1 className="governance-title mt-5 max-w-[960px]">Shadow AI governance.<br /><span className="font-pixel">Keep work moving.</span></h1>
        <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-20">
          <div>
            <p className="max-w-[650px] text-lg leading-8 text-[var(--lp-body)]">People are already using AI at work. Manage shadow AI with an approved path for models, tools, and company data—not a blanket ban on useful work.</p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row"><Link href="/enterprise#book" className="lp-pill-primary">Plan your rollout</Link><a href="#framework" className="lp-pill-secondary">See the framework</a></div>
          </div>
          <aside className="border-l-2 border-[var(--lp-ink)] pl-6 text-base leading-7">
            <p className="font-medium">Govern access. Keep choice.</p>
            <p className="mt-3 text-[var(--lp-body)]">OpenWork gives IT one controlled path for supported model traffic, while teams keep familiar agents and workflows.</p>
            <Link href="/ai-governance" className="governance-link mt-4 inline-block">Read the AI governance guide</Link>
          </aside>
        </div>
      </section>

      <GovernanceSection id="risks" label="The unmanaged part is the problem" title="What is shadow AI, and why is it a risk?">
        <p>Shadow AI is the use of AI at work without company approval or oversight: personal chatbot accounts, unsanctioned AI tools, browser assistants, or coding agents using personal API keys with company files.</p>
        <p>The work may be valuable. The risk is that nobody has agreed on where the data goes, who has access, or how to investigate a problem.</p>
        <dl className="mt-6 divide-y divide-[var(--lp-border)]">
          {[
            ["Data leakage", "Prompts, attachments, and agent context can send confidential material to providers the company has not reviewed."],
            ["Compliance gaps", "Unreviewed terms, retention, and processing locations can conflict with contractual obligations and internal data rules."],
            ["No reliable audit trail", "Personal accounts and scattered keys leave security teams without a consistent record of who used which approved model."],
            ["Access that outlives the employee", "Unmanaged accounts and credentials complicate offboarding, incident response, and spend ownership."]
          ].map(([title, body]) => <div key={title} className="py-5"><dt className="font-medium text-[var(--lp-ink)]">{title}</dt><dd className="mt-2">{body}</dd></div>)}
        </dl>
      </GovernanceSection>

      <section id="framework" aria-labelledby="framework-heading" className="governance-section scroll-mt-8">
        <p className="governance-label">A practical shadow AI governance framework</p>
        <h2 id="framework-heading" className="governance-heading mt-3 max-w-[740px]">Make the approved way the useful way.</h2>
        <ol className="mt-10 divide-y divide-[var(--lp-border)]">
          {[
            ["Discover", "Start with real work, not a tool blacklist.", "Ask teams which AI tools they use and why. Review existing software inventories, procurement records, and endpoint or network signals where permitted. Record tools, accounts, data classes, and owners."],
            ["Set policy", "Write down what is allowed.", "An AI usage policy should name approved tools and providers, prohibited data, who can grant exceptions, and how to report an incident. Involve security, legal, IT, and the people doing the work."],
            ["Give a sanctioned path", "Offer access before asking people to switch.", "Configure company sign-in, model permissions, and approved providers. Give employees a usable AI gateway and clear setup instructions for supported clients—not another reason to use a personal account."],
            ["Monitor and improve", "Review the path you actually control.", "Check routed usage and spend, review access when roles change, and revisit exceptions. Combine gateway visibility with discovery controls to identify activity outside the approved path."]
          ].map(([step, title, body], index) => <li key={step} className="grid gap-4 py-7 md:grid-cols-[180px_1fr] md:gap-12"><div className="flex gap-4 text-sm"><span className="mono text-[var(--lp-muted)]">0{index + 1}</span><span className="font-medium">{step}</span></div><div><h3 className="text-xl font-medium tracking-tight">{title}</h3><p className="mt-3 max-w-[740px] text-base leading-7 text-[var(--lp-body)]">{body}</p></div></li>)}
        </ol>
        <Link href="/ai-governance#policy" className="governance-link mt-5 inline-block">Build your AI usage policy</Link>
      </section>

      <section id="how-it-works" aria-labelledby="gateway-heading" className="governance-section">
        <p className="governance-label">How OpenWork helps</p>
        <h2 id="gateway-heading" className="governance-heading mt-3 max-w-[760px]">One AI gateway.<br />A company-controlled model path.</h2>
        <p className="mt-6 max-w-[740px] text-base leading-7 text-[var(--lp-body)]">Configure supported clients to use your organization&apos;s models. SSO identifies the employee, permissions control model access, and centrally provisioned providers—including AWS Bedrock—replace scattered personal keys. Review usage and spend for requests routed through the gateway.</p>
        <ModelTrafficPath />
        <p className="mt-6 max-w-[850px] border-l-2 border-[var(--lp-border)] pl-5 text-sm leading-6 text-[var(--lp-body)]">OpenWork governs traffic routed through it. It does not automatically discover or block every personal AI account or tool outside that path. Use endpoint and network controls where you need broader detection or enforcement.</p>
      </section>

      <GovernanceSection id="tools" label="Different tools, shared capabilities" title="Governance shouldn’t mean one agent for everyone.">
        <p>Support multiple AI coding tools and agents so teams keep the tools they like. OpenWork and <Link href="/guides/openwork-and-opencode">OpenCode with the OpenWork plugin</Link> can use company AI gateway models.</p>
        <p>Claude Code, Codex, and Cursor can use the <Link href="/connect">MCP gateway</Link> for shared skills and connections. AI gateway model integration for those clients is in progress. Adding MCP alone does not route their model traffic.</p>
        <Link href="/guides/claude-code-codex-cursor" className="governance-link inline-block">Explore AI coding tools and agents</Link>
      </GovernanceSection>

      <section aria-labelledby="data-heading" className="governance-section rounded-[24px] bg-[var(--lp-tonal)] p-6 md:p-12">
        <p className="governance-label">Know the data boundary</p>
        <h2 id="data-heading" className="governance-heading mt-3">Local files. Not zero data flow.</h2>
        <div className="mt-6 grid gap-6 text-base leading-7 text-[var(--lp-body)] md:grid-cols-2 md:gap-12">
          <p>In the local desktop model-gateway setup, files and the workspace stay on the user&apos;s PC. Workspace processing sends SSO configuration and model traffic, not a copy of the workspace. You do not need to move work into a cloud worker to govern model access.</p>
          <p>Model traffic includes prompts, responses, and file content the agent includes as context. Remote models may therefore see company data. Product analytics, diagnostics, update checks, optional cloud workers, and connected services have separate data flows.</p>
        </div>
        <Link href="/privacy" className="governance-link mt-6 inline-block">Read the privacy policy</Link>
      </section>

      <GovernanceSection id="rollout" label="IT and security rollout checklist" title="Turn policy into an everyday workflow.">
        <ul className="list-disc space-y-4 pl-5 marker:text-[var(--lp-ink)]">
          <li>Assign an IT owner and a security reviewer. Inventory existing tools and classify the data used with them.</li>
          <li>Approve providers, retention terms, permitted data, and an exception process. Publish the AI usage policy.</li>
          <li>Configure SSO, model permissions, and provider credentials. Verify access with both an allowed and a restricted account.</li>
          <li>Install per user and pilot supported clients. Confirm model routing and inspect the data boundary with a non-sensitive task.</li>
          <li>Train employees, review gateway usage, and test offboarding. Agree on support ownership before expanding.</li>
        </ul>
        <Link href="/enterprise" className="governance-link inline-block">Plan enterprise deployment</Link>
      </GovernanceSection>
      <GovernanceFaq entries={shadowAiFaq} title="Shadow AI governance FAQ" />
      <GovernanceNextSteps />
      <div className="mt-16"><SiteFooter /></div>
    </main>
  </div>;
}
