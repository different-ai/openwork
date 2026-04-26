import Eyebrow from "@/components/ui/eyebrow";
import DotsPattern from "@/components/ui/dots-pattern";
import LogoSymbolIcon from "@/icons/logos/logo-symbol";
import {
  dataHandlingRows,
  keyFacts,
  sectionAnchors,
  securityContact,
  subprocessors
} from "./trust-content";

type SharedProps = {
  stars: string;
  downloadHref: string;
  calUrl: string;
};

/* ------------------------------------------------------------------ */
/*  Shared primitives                                                 */
/* ------------------------------------------------------------------ */

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="scroll-mt-24 font-sans text-[3.2rem] font-bold leading-[1.1] tracking-[-0.02em] text-foreground"
    >
      {children}
    </h2>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="border-foreground/10 gap-base flex items-start border-l-2 pl-base py-xs text-foreground/70 font-sans text-base leading-relaxed">
      <span>{children}</span>
    </li>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return (
    <p className="body-base mt-base">{children}</p>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export function LandingTrustOverview(_props: SharedProps) {
  return (
    <div className="trust-page relative min-h-screen pt-(--page-pt)">
      <main className="mx-auto flex w-full max-w-(--max-container) flex-col gap-[6.4rem] px-(--container-px) pb-[8rem]">
        {/* ── Hero ── */}
        <section className="grid-12 relative z-0 gap-y-base sm:gap-y-xl">
          <DotsPattern className="opacity-40" />
          <div className="col-span-12 md:col-span-8 md:col-start-3 flex flex-col items-center text-center gap-base sm:gap-xl">
            <Eyebrow>Trust & Security</Eyebrow>
            <h1 data-split="heading" className="h1">
              Your servers. <span className="h1-serif">Your data.</span>
              <br />
              Your keys.
            </h1>
            <p className="body-base text-balance">
              OpenWork enterprise runs on your servers. We don&apos;t see your code, your API keys, or your prompts.
              No hosted control plane. No phone-home telemetry. Self-hosted by default — and that&apos;s the only mode
              that exists.
            </p>
          </div>

          <nav className="col-span-12 md:col-span-10 md:col-start-2 mt-base flex flex-wrap items-center justify-center gap-x-base gap-y-sm font-sans text-base-sm font-medium text-foreground/60">
            {sectionAnchors.map((a, i) => (
              <span key={a.id} className="flex items-center gap-base">
                {i > 0 && <span className="text-foreground/20">·</span>}
                <a
                  href={`#${a.id}`}
                  data-underline-link
                  className="hover:text-primary transition-colors"
                >
                  {a.label}
                </a>
              </span>
            ))}
          </nav>
        </section>

        {/* ── Key Facts Grid ── */}
        <section className="grid-12">
          <div className="col-span-12 grid grid-cols-2 md:grid-cols-3 gap-base">
            {keyFacts.map((fact) => {
              const Icon = fact.icon;
              return (
                <div
                  key={fact.label}
                  data-cursor="accent"
                  className="bg-background-muted relative z-0 flex flex-col gap-base p-lg rounded-sm overflow-hidden"
                >
                  <DotsPattern className="opacity-40" />
                  <div className="border-primary text-primary grid size-[4.8rem] place-content-center rounded-full border border-dashed">
                    <Icon size={20} />
                  </div>
                  <div className="text-foreground/40 font-sans text-base-sm font-bold uppercase tracking-wide">
                    {fact.label}
                  </div>
                  <div className="font-serif text-[2.8rem] font-light leading-none italic">
                    {fact.value}
                  </div>
                  <div className="text-foreground/60 font-sans text-base-sm font-medium">
                    {fact.detail}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Deployment Model ── */}
        <section className="grid-12 gap-y-base">
          <div className="col-span-12 md:col-span-4 flex flex-col gap-base">
            <Eyebrow>01</Eyebrow>
            <SectionHeading id="deployment">Deployment model</SectionHeading>
          </div>
          <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col gap-base">
            <Prose>
              OpenWork ships as a desktop app that you host on your own servers. You bring your own LLM gateway and
              your own auth stack. Traffic between your users and their LLM provider goes direct — we don&apos;t sit in
              the middle.
            </Prose>
            <ul className="gap-sm flex flex-col">
              <Bullet>
                <strong className="text-foreground">Desktop app</strong> runs on your servers. No data leaves your
                infrastructure unless a user explicitly connects to an LLM provider.
              </Bullet>
              <Bullet>
                <strong className="text-foreground">LLM gateway</strong> is your choice (LiteLLM, Cloudflare AI
                Gateway, etc.). OpenWork doesn&apos;t proxy, store, or log API traffic.
              </Bullet>
              <Bullet>
                <strong className="text-foreground">Authentication</strong> plugs into your existing SSO or SAML
                provider.
              </Bullet>
            </ul>
          </div>
        </section>

        {/* ── Data Handling ── */}
        <section className="grid-12 gap-y-base">
          <div className="col-span-12 md:col-span-4 flex flex-col gap-base">
            <Eyebrow>02</Eyebrow>
            <SectionHeading id="data-handling">Data handling</SectionHeading>
          </div>
          <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col gap-base">
            <Prose>We receive zero customer data in a self-hosted deployment.</Prose>
            <div className="bg-background-muted overflow-x-auto rounded-sm">
              <table className="w-full font-sans text-base-sm">
                <thead>
                  <tr className="border-foreground/10 border-b">
                    <th className="px-base py-base text-left font-bold">Data type</th>
                    <th className="px-base py-base text-left font-bold">Self-hosted</th>
                    <th className="px-base py-base text-left font-bold">Cloud</th>
                  </tr>
                </thead>
                <tbody>
                  {dataHandlingRows.map((row) => (
                    <tr key={row.dataType} className="border-foreground/10 border-b last:border-0">
                      <td className="px-base py-base font-medium text-foreground">{row.dataType}</td>
                      <td className="px-base py-base text-foreground/60">{row.selfHosted}</td>
                      <td className="px-base py-base text-foreground/60">{row.cloud}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Data Residency ── */}
        <section className="grid-12 gap-y-base">
          <div className="col-span-12 md:col-span-4 flex flex-col gap-base">
            <Eyebrow>03</Eyebrow>
            <SectionHeading id="data-residency">Data residency</SectionHeading>
          </div>
          <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col gap-base">
            <Prose>
              You pick the region, the network boundary, and the egress policy. Nothing replicates outside your
              environment.
            </Prose>
            <ul className="gap-sm flex flex-col">
              <Bullet>OpenWork doesn&apos;t impose a data region. You decide where things live.</Bullet>
              <Bullet>
                Switching your LLM provider doesn&apos;t affect where data is stored. The two decisions are independent.
              </Bullet>
            </ul>
          </div>
        </section>

        {/* ── Subprocessors ── */}
        <section className="grid-12 gap-y-base">
          <div className="col-span-12 md:col-span-4 flex flex-col gap-base">
            <Eyebrow>04</Eyebrow>
            <SectionHeading id="subprocessors">Subprocessors</SectionHeading>
          </div>
          <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col gap-base">
            <Prose>
              These vendors apply to the OpenWork website and cloud service only. If you self-host, none of them touch
              your environment.
            </Prose>
            <div className="bg-background-muted overflow-x-auto rounded-sm">
              <table className="w-full font-sans text-base-sm">
                <thead>
                  <tr className="border-foreground/10 border-b">
                    <th className="px-base py-base text-left font-bold">Vendor</th>
                    <th className="px-base py-base text-left font-bold">Purpose</th>
                    <th className="px-base py-base text-left font-bold">Category</th>
                    <th className="px-base py-base text-left font-bold">Region</th>
                  </tr>
                </thead>
                <tbody>
                  {subprocessors.map((sp) => (
                    <tr key={sp.name} className="border-foreground/10 border-b last:border-0">
                      <td className="px-base py-base font-medium text-foreground">
                        <a
                          href={sp.href}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-primary transition-colors"
                          data-underline-link
                        >
                          {sp.name}
                        </a>
                      </td>
                      <td className="px-base py-base text-foreground/60">{sp.purpose}</td>
                      <td className="px-base py-base text-foreground/60">{sp.category}</td>
                      <td className="px-base py-base text-foreground/60">{sp.location}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Incident Response ── */}
        <section className="grid-12 gap-y-base">
          <div className="col-span-12 md:col-span-4 flex flex-col gap-base">
            <Eyebrow>05</Eyebrow>
            <SectionHeading id="incident-response">Incident response</SectionHeading>
          </div>
          <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col gap-base">
            <Prose>Report security issues via email or GitHub issue. Our response commitments:</Prose>
            <ul className="gap-sm flex flex-col">
              <Bullet>
                Acknowledge receipt within <strong className="text-foreground">3 business days</strong>
              </Bullet>
              <Bullet>
                Initial triage and assessment within <strong className="text-foreground">7 business days</strong>
              </Bullet>
              <Bullet>
                Notify affected customers of any major security incident within{" "}
                <strong className="text-foreground">72 hours</strong>
              </Bullet>
            </ul>
            <p className="text-foreground/60 font-sans text-base-sm">
              See our{" "}
              <a
                href="https://github.com/different-ai/openwork/blob/dev/SECURITY.md"
                target="_blank"
                rel="noreferrer"
                className="text-foreground hover:text-primary transition-colors"
                data-underline-link
              >
                security policy
              </a>{" "}
              for reporting guidelines.
            </p>
          </div>
        </section>

        {/* ── Compliance ── */}
        <section className="grid-12 gap-y-base">
          <div className="col-span-12 md:col-span-4 flex flex-col gap-base">
            <Eyebrow>06</Eyebrow>
            <SectionHeading id="compliance">Compliance</SectionHeading>
          </div>
          <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col gap-base">
            <div className="bg-background-muted overflow-x-auto rounded-sm">
              <table className="w-full font-sans text-base-sm">
                <thead>
                  <tr className="border-foreground/10 border-b">
                    <th className="px-base py-base text-left font-bold">Certification</th>
                    <th className="px-base py-base text-left font-bold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-foreground/10 border-b last:border-0">
                    <td className="px-base py-base font-medium text-foreground">SOC 2 Type II</td>
                    <td className="px-base py-base text-foreground/60">In progress</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Prose>
              If you need a DPA or help with a vendor security questionnaire, reach out below.
            </Prose>
          </div>
        </section>

        {/* ── Security Contact ── */}
        <section className="grid-12 gap-y-base">
          <div className="col-span-12 md:col-span-4 flex flex-col gap-base">
            <Eyebrow>07</Eyebrow>
            <SectionHeading id="contact">Security contact</SectionHeading>
          </div>
          <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col gap-base">
            <Prose>Security questions, vendor questionnaires, vulnerability reports:</Prose>
            <div className="bg-background-muted relative z-0 flex items-center gap-base p-lg rounded-sm overflow-hidden">
              <DotsPattern className="opacity-40" />
              <div className="border-primary grid size-[6.4rem] shrink-0 place-content-center rounded-full border border-dashed">
                <LogoSymbolIcon className="w-[2.8rem]" />
              </div>
              <div className="flex flex-col gap-2xs">
                <div className="font-sans text-base-lg font-bold">{securityContact.name}</div>
                <a
                  href={`mailto:${securityContact.email}`}
                  className="hover:text-primary text-foreground/60 font-sans text-base font-medium transition-colors"
                  data-underline-link
                >
                  {securityContact.email}
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
