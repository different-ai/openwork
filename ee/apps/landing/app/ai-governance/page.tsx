import Link from "next/link";
import { GovernanceFaq, GovernanceNextSteps, GovernanceSection } from "../../components/governance-primitives";
import { SiteNav } from "../../components/site-nav";
import { SiteFooter } from "../../components/site-footer";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";
import { aiGovernanceFaq } from "../../lib/ai-governance";

export const metadata = withSocialMetadata({
  title: "AI governance — A practical enterprise framework | OpenWork",
  description: "Build enterprise AI governance around an actionable AI usage policy, approved tools, and model access. Learn what to evaluate in an AI governance platform.",
  alternates: { canonical: "/ai-governance" },
  openGraph: { url: "https://openworklabs.com/ai-governance" }
});

export default async function AiGovernancePage() {
  const github = await getGithubData();
  return <div className="min-h-screen bg-[var(--lp-page)] text-[var(--lp-ink)]">
    <SiteNav stars={github.stars} />
    <main id="main-content" className="mx-auto w-full max-w-[1176px] px-6 pb-8">
      <section className="governance-hero">
        <p className="governance-label">A field guide for IT and security</p>
        <h1 className="governance-title mt-5 max-w-[950px]">AI governance.<br /><span className="font-pixel">From policy to practice.</span></h1>
        <p className="mt-7 max-w-[740px] text-lg leading-8 text-[var(--lp-body)]">Decide who can use AI, with which data, and through which providers. Then make those decisions part of how work gets done.</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row"><a href="#policy" className="lp-pill-primary">Build your AI usage policy</a><Link href="/enterprise#book" className="lp-pill-secondary">Book a demo</Link></div>
      </section>

      <GovernanceSection id="definition" label="An operating model, not a document" title="What is enterprise AI governance?">
        <p>AI governance is the combination of accountability, policy, and controls for using AI responsibly. For employee-facing tools, that means reviewing providers, classifying data, granting access, checking outputs, and knowing how to respond when something goes wrong.</p>
        <p>Enterprise AI governance connects those decisions across IT, security, legal, procurement, and business teams. A policy without a usable approved tool can leave <Link href="/shadow-ai">shadow AI</Link> untouched. A tool without an owner leaves important decisions to chance.</p>
        <p>This guide focuses on employee tools and agents. Developing or deploying your own AI models may also require model-risk assessment, evaluation, and other obligations beyond this scope.</p>
      </GovernanceSection>

      <section id="policy" aria-labelledby="policy-heading" className="governance-section scroll-mt-8">
        <p className="governance-label">Your AI usage policy</p><h2 id="policy-heading" className="governance-heading mt-3 max-w-[760px]">Answer the questions employees actually have.</h2>
        <p className="mt-6 max-w-[740px] text-base leading-7 text-[var(--lp-body)]">Use these prompts as a working checklist, not a legal template. Have your security and legal owners adapt the policy to your data, contracts, and obligations.</p>
        <dl className="mt-9 divide-y divide-[var(--lp-border)] border-y border-[var(--lp-border)]">
          {[
            ["Which tools can I use?", "List approved clients, accounts, models, and providers. Explain how to request a new tool and who reviews it."],
            ["What data can I include?", "Define permitted data classes and prohibited material. Cover prompts, file attachments, agent context, connected services, and secrets."],
            ["Who gets access?", "Name the access owner, the approval route, and how access changes when employees move teams or leave."],
            ["What needs human review?", "Set review expectations for AI output, code, customer-facing work, and actions an agent takes on someone's behalf."],
            ["What happens when things go wrong?", "Give employees an incident reporting channel, an exception process, and a clear owner for investigation."],
            ["When do we revisit this?", "Choose a review cadence and update triggers, including new providers, tools, data categories, and contractual requirements."]
          ].map(([question, answer]) => <div key={question} className="grid gap-3 py-6 md:grid-cols-[1fr_1.6fr] md:gap-16"><dt className="text-lg font-medium">{question}</dt><dd className="text-base leading-7 text-[var(--lp-body)]">{answer}</dd></div>)}
        </dl>
      </section>

      <GovernanceSection id="platform" label="Evaluate the platform, not the promise" title="What to look for in an AI governance platform.">
        <p>Start with the controls your policy needs. Ask vendors to demonstrate each one with a real account and a non-sensitive task. Separate shipped behavior from roadmap commitments.</p>
        <ul className="list-disc space-y-4 pl-5">
          <li><strong>Identity and offboarding.</strong> Test company SSO, provisioning, and access removal—not just the sign-in screen.</li>
          <li><strong>Model and provider control.</strong> Verify permissions and provider choice, such as AWS Bedrock, for each client you intend to approve.</li>
          <li><strong>Visibility with a defined scope.</strong> Understand what usage is recorded, who can see it, and what traffic is outside the platform.</li>
          <li><strong>A clear data boundary.</strong> Trace prompts, file context, credentials, logs, and connected-service traffic. Review retention and processing terms separately.</li>
          <li><strong>A practical employee experience.</strong> Check installation, onboarding, familiar tool support, and a clear path for exceptions.</li>
        </ul>
      </GovernanceSection>

      <section aria-labelledby="openwork-heading" className="governance-section rounded-[24px] bg-[var(--lp-tonal)] p-6 md:p-12">
        <p className="governance-label">Where OpenWork fits</p><h2 id="openwork-heading" className="governance-heading mt-3 max-w-[750px]">A governed path for everyday AI work.</h2>
        <div className="governance-prose mt-6 max-w-[850px]">
          <p>OpenWork combines a local-first desktop workspace with organization-managed model access. The AI gateway provides company sign-in, permissions, provider choice, and visibility into routed model usage.</p>
          <p>OpenWork and OpenCode with the OpenWork plugin support company AI gateway models. Claude Code, Codex, and Cursor can use the MCP gateway for shared skills and connections; AI gateway model integration for those clients is in progress. Connecting MCP alone does not route model traffic.</p>
          <p>Files stay on the user&apos;s PC in local desktop mode, but prompts and file context sent to a remote model leave the device. Analytics, diagnostics, updates, connected services, and optional cloud workers have separate flows. OpenWork is not a network-wide discovery or data-loss prevention tool.</p>
          <div className="flex flex-wrap gap-x-6 gap-y-3"><Link href="/enterprise" className="governance-link">Explore OpenWork Enterprise</Link><Link href="/privacy" className="governance-link">Review the data policy</Link></div>
        </div>
      </section>

      <GovernanceSection id="rollout" label="Start small, review, then expand" title="Make secure AI for employees a repeatable practice.">
        <p>Discover existing use with team interviews, software inventories, and permitted endpoint or network signals. Set policy before connecting sensitive data. Pilot a sanctioned path with a small group, and test access, provider routing, output review, and offboarding.</p>
        <p>Monitor adoption and exceptions, not just spend. Usage through a gateway tells you about that path; it does not prove nobody is using another tool. Keep your broader discovery and incident processes in place.</p>
        <Link href="/shadow-ai#framework" className="governance-link inline-block">Use the four-step shadow AI framework</Link>
      </GovernanceSection>
      <GovernanceFaq entries={aiGovernanceFaq} title="AI governance FAQ" />
      <GovernanceNextSteps />
      <div className="mt-16"><SiteFooter /></div>
    </main>
  </div>;
}
