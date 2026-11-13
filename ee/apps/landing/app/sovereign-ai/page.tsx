import Link from "next/link";
import { GovernanceFaq, GovernanceNextSteps, GovernanceSection } from "../../components/governance-primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { SovereigntyCoverage } from "../../components/sovereignty-coverage";
import { SovereigntyLevels, SovereigntySetups } from "../../components/sovereignty-pieces";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";
import { CLOUD_AI_ACT_URL, SOVEREIGNTY_FRAMEWORK_NEWS_URL, SOVEREIGNTY_FRAMEWORK_URL, sovereignAiFaq } from "../../lib/sovereign-ai";
import { TRUST_CENTER_URL } from "../../lib/trust-center";

export const metadata = withSocialMetadata({
  title: "Sovereign AI — The EU Cloud Sovereignty Framework, piece by piece | OpenWork",
  description: "What the EU Cloud Sovereignty Framework asks for, objective by objective. Pick your setup to see how far a self-hosted AI workspace gets you, and what is left.",
  alternates: { canonical: "/sovereign-ai" },
  openGraph: { url: "https://openworklabs.com/sovereign-ai" }
});

export default async function SovereignAiPage() {
  const github = await getGithubData();
  return <div className="min-h-screen bg-[var(--lp-page)] text-[var(--lp-ink)]">
    <SiteNav stars={github.stars} />
    <main id="main-content" className="mx-auto w-full max-w-[1176px] px-6 pb-8">
      <section className="governance-hero">
        <p className="governance-label">A field guide for European IT and security</p>
        <h1 className="governance-title mt-5 max-w-[960px]">Sovereign AI.<br /><span className="font-pixel">On infrastructure you choose.</span></h1>
        <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:gap-20">
          <div>
            <p className="max-w-[650px] text-lg leading-8 text-[var(--lp-body)]">Europe now scores cloud and AI services on who controls them. Most of that score is set by where your AI runs and which model it calls. OpenWork is the workspace built to run on whatever you pick.</p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row"><a href="#pieces" className="lp-pill-primary">See how far OpenWork gets you</a><Link href="/enterprise#book" className="lp-pill-secondary">Book a demo</Link></div>
          </div>
          <aside className="border-l-2 border-[var(--lp-ink)] pl-6 text-base leading-7">
            <p className="font-medium">We don&apos;t claim a level.</p>
            <p className="mt-3 text-[var(--lp-body)]">Levels are assigned by a buyer or an auditor to a whole service, not to one piece of software. This page counts what OpenWork answers on each objective in your setup, and lists what is still open.</p>
          </aside>
        </div>
      </section>

      <GovernanceSection id="documents" label="What Europe is asking for" title="Two documents, one question: who is in control?">
        <p><strong>The Cloud Sovereignty Framework.</strong> Published by the European Commission in October 2025. It has eight objectives and five assurance levels. The Commission uses it to buy its own cloud services, and since June 2026 it encourages public and private organizations to use it too.</p>
        <p><strong>The Cloud and AI Development Act.</strong> Proposed by the Commission in June 2026 and not law yet. It would set four assurance levels and require public bodies in critical sectors to buy at level two or above.</p>
        <p>Neither is the EU AI Act, which regulates how AI systems are built and used. Both score services and providers, and the buyer or an auditor assigns the level.</p>
        <p><a href={SOVEREIGNTY_FRAMEWORK_URL} target="_blank" rel="noreferrer">Read the framework</a> · <a href={SOVEREIGNTY_FRAMEWORK_NEWS_URL} target="_blank" rel="noreferrer">The Commission&apos;s explainer</a> · <a href={CLOUD_AI_ACT_URL} target="_blank" rel="noreferrer">The proposed act</a></p>
      </GovernanceSection>

      <section id="levels" aria-labelledby="levels-heading" className="governance-section scroll-mt-24">
        <p className="governance-label">The levels</p>
        <h2 id="levels-heading" className="governance-heading mt-3 max-w-[760px]">Five steps, from no control to full control.</h2>
        <p className="mt-6 max-w-[740px] text-base leading-7 text-[var(--lp-body)]">A buyer sets a minimum level for each objective. A service that falls short on any one of them is out. Most organizations need a higher level for some work than for the rest.</p>
        <SovereigntyLevels />
      </section>

      <section id="pieces" aria-labelledby="pieces-heading" className="governance-section scroll-mt-24">
        <p className="governance-label">The eight pieces</p>
        <h2 id="pieces-heading" className="governance-heading mt-3 max-w-[760px]">How far OpenWork gets you, piece by piece.</h2>
        <p className="mt-6 max-w-[740px] text-base leading-7 text-[var(--lp-body)]">The framework was written for cloud services, and an AI workspace is one layer of yours. Pick your setup to see what OpenWork answers on each of the eight objectives, and what is left.</p>
        <SovereigntyCoverage />
      </section>

      <section id="setups" aria-labelledby="setups-heading" className="governance-section scroll-mt-24">
        <p className="governance-label">Same workspace, different level</p>
        <h2 id="setups-heading" className="governance-heading mt-3 max-w-[760px]">Start where you are. Move up without changing tools.</h2>
        <p className="mt-6 max-w-[740px] text-base leading-7 text-[var(--lp-body)]">Two setups we see in Europe. The workspace is the same in both. What differs is the model and who operates it, and that is what an assessor will look at first.</p>
        <SovereigntySetups />
        <p className="mt-6 max-w-[740px] text-sm leading-6 text-[var(--lp-muted)]">Which level either setup earns is your assessor&apos;s call.</p>
      </section>

      <GovernanceSection id="questions" label="Before you pick a workspace" title="Six questions to ask any AI vendor.">
        <ol className="list-decimal space-y-4 pl-5 marker:text-[var(--lp-muted)]">
          <li>Does it run entirely on infrastructure we operate?</li>
          <li>Can we use any model, including one we serve ourselves?</li>
          <li>Does it sign people in with our identity provider?</li>
          <li>Which hosts does it contact, and can each one be mirrored or turned off?</li>
          <li>Can we read the source and apply a patch without the vendor?</li>
          <li>What happens to our deployment if the contract ends?</li>
        </ol>
        <p>Our answers are in the <Link href="/docs/start-here/self-host">self-hosting guide</Link>, the <Link href="/docs/start-here/outbound-network-access">outbound network list</Link>, and the <Link href="/docs/start-here/air-gapped-deployment">air-gapped deployment guide</Link>. Certifications are in the <a href={TRUST_CENTER_URL} target="_blank" rel="noreferrer">trust center</a>.</p>
      </GovernanceSection>

      <section aria-labelledby="boundary-heading" className="governance-section rounded-[24px] bg-[var(--lp-tonal)] p-6 md:p-12">
        <p className="governance-label">Know the boundary</p>
        <h2 id="boundary-heading" className="governance-heading mt-3">A workspace. Not a sovereign cloud.</h2>
        <div className="mt-6 grid gap-6 text-base leading-7 text-[var(--lp-body)] md:grid-cols-2 md:gap-12">
          <p>OpenWork does not supply your hardware, your data centre, or your models. Those set most of your level. A workspace can only avoid pulling it down: no required vendor cloud, no fixed model, no fixed identity provider.</p>
          <p>OpenWork Cloud is our hosted service, operated by a US company. If you are working to a sovereignty level, self-host. And whatever you host, the model still sees prompts and the file content sent as context.</p>
        </div>
        <Link href="/enterprise" className="governance-link mt-6 inline-block">Plan a self-hosted deployment</Link>
      </section>

      <GovernanceFaq entries={sovereignAiFaq} title="Sovereign AI FAQ" />
      <GovernanceNextSteps />
      <div className="mt-16"><SiteFooter /></div>
    </main>
  </div>;
}
