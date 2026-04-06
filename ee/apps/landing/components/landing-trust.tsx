import { SiteFooter } from "./site-footer";
import { LandingBackground } from "./landing-background";
import { SiteNav } from "./site-nav";
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
      className="scroll-mt-24 text-xl font-semibold tracking-tight text-[#011627]"
    >
      {children}
    </h2>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
      <span>{children}</span>
    </li>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-[14px] leading-relaxed text-slate-600">{children}</p>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export function LandingTrustOverview(props: SharedProps) {
  const callHref = props.calUrl || "/enterprise#book";

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={props.stars}
            callUrl={callHref}
            downloadHref={props.downloadHref}
          />
        </div>

        <main className="mx-auto w-full max-w-3xl flex-1 px-6 pb-16 md:px-8">
          {/* ── Header ── */}
          <section className="pt-8 md:pt-12">
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
              Security &amp; Data Privacy
            </h1>
            <Prose>
              OpenWork enterprise runs on your servers. We don&apos;t see your code, your API
              keys, or your prompts. There is no hosted control plane and no
              phone-home telemetry.
            </Prose>
          </section>

          {/* ── On this page ── */}
          <nav className="mt-6 flex flex-wrap gap-x-1 gap-y-1 text-[12px]">
            {sectionAnchors.map((a, i) => (
              <span key={a.id} className="flex items-center">
                {i > 0 && <span className="mr-1 text-slate-300">·</span>}
                <a
                  href={`#${a.id}`}
                  className="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-[#011627]"
                >
                  {a.label}
                </a>
              </span>
            ))}
          </nav>

          {/* ── Key Facts Grid ── */}
          <section className="mt-8">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {keyFacts.map((fact) => {
                const Icon = fact.icon;
                return (
                  <div
                    key={fact.label}
                    className="rounded-xl border border-slate-200/70 bg-white/80 p-4"
                  >
                    <Icon size={16} className="text-slate-400" />
                    <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {fact.label}
                    </div>
                    <div className="mt-1 text-[15px] font-semibold text-[#011627]">
                      {fact.value}
                    </div>
                    <div className="mt-0.5 text-[12px] text-slate-500">
                      {fact.detail}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── Deployment Model ── */}
          <section className="mt-14">
            <SectionHeading id="deployment">Deployment model</SectionHeading>
            <Prose>
              OpenWork ships as a desktop app that you host on your own servers. You
              bring your own LLM gateway and your own auth stack. Traffic between
              your users and their LLM provider goes direct; we don&apos;t sit in the
              middle.
            </Prose>
            <ul className="mt-4 space-y-2.5 text-[14px] leading-relaxed text-slate-600">
              <Bullet>
                <strong>Desktop app</strong> runs on your servers. No data leaves
                your infrastructure unless a user explicitly connects to an LLM
                provider.
              </Bullet>
              <Bullet>
                <strong>LLM gateway</strong> is your choice (LiteLLM, Cloudflare AI
                Gateway, etc.). OpenWork doesn&apos;t proxy, store, or log API
                traffic.
              </Bullet>
              <Bullet>
                <strong>Authentication</strong> plugs into your existing SSO or SAML
                provider.
              </Bullet>
            </ul>
          </section>

          {/* ── Data Handling ── */}
          <section className="mt-14">
            <SectionHeading id="data-handling">Data handling</SectionHeading>
            <Prose>
              We receive zero customer data in a self-hosted deployment.
            </Prose>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200/70">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200/70 bg-slate-50/80">
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Data type
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Self-hosted
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Cloud
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dataHandlingRows.map((row) => (
                    <tr
                      key={row.dataType}
                      className="border-b border-slate-200/70 last:border-0"
                    >
                      <td className="px-4 py-2.5 font-medium text-[#011627]">
                        {row.dataType}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {row.selfHosted}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{row.cloud}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Data Residency ── */}
          <section className="mt-14">
            <SectionHeading id="data-residency">Data residency</SectionHeading>
            <Prose>
              You pick the region, the network boundary, and the egress policy.
              Nothing replicates outside your environment.
            </Prose>
            <ul className="mt-4 space-y-2.5 text-[14px] leading-relaxed text-slate-600">
              <Bullet>
                OpenWork doesn&apos;t impose a data region. You decide where things
                live.
              </Bullet>
              <Bullet>
                Switching your LLM provider doesn&apos;t affect where data is stored.
                The two decisions are independent.
              </Bullet>
            </ul>
          </section>

          {/* ── Subprocessors ── */}
          <section className="mt-14">
            <SectionHeading id="subprocessors">Subprocessors</SectionHeading>
            <Prose>
              These vendors apply to the OpenWork website and cloud service only.
              If you self-host, none of them touch your environment.
            </Prose>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200/70">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200/70 bg-slate-50/80">
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Vendor
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Purpose
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Category
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Region
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {subprocessors.map((sp) => (
                    <tr
                      key={sp.name}
                      className="border-b border-slate-200/70 last:border-0"
                    >
                      <td className="px-4 py-2.5 font-medium text-[#011627]">
                        <a
                          href={sp.href}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                        >
                          {sp.name}
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{sp.purpose}</td>
                      <td className="px-4 py-2.5 text-slate-600">{sp.category}</td>
                      <td className="px-4 py-2.5 text-slate-600">{sp.location}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Incident Response ── */}
          <section className="mt-14">
            <SectionHeading id="incident-response">Incident response</SectionHeading>
            <Prose>
              Report security issues via email or GitHub issue. Our response
              commitments:
            </Prose>
            <ul className="mt-4 space-y-2.5 text-[14px] leading-relaxed text-slate-600">
              <Bullet>
                Acknowledge receipt within <strong>3 business days</strong>
              </Bullet>
              <Bullet>
                Initial triage and assessment within <strong>7 business days</strong>
              </Bullet>
              <Bullet>
                Notify affected customers of any major security incident within{" "}
                <strong>72 hours</strong>
              </Bullet>
            </ul>
            <div className="mt-4 text-[13px] text-slate-500">
              See our{" "}
              <a
                href="https://github.com/different-ai/openwork/blob/dev/SECURITY.md"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-slate-300 underline-offset-2 hover:text-[#011627]"
              >
                security policy
              </a>{" "}
              for reporting guidelines.
            </div>
          </section>

          {/* ── Compliance ── */}
          <section className="mt-14">
            <SectionHeading id="compliance">Compliance</SectionHeading>
            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200/70">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200/70 bg-slate-50/80">
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Certification
                    </th>
                    <th className="px-4 py-2.5 text-left font-semibold text-slate-600">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-slate-200/70 last:border-0">
                    <td className="px-4 py-2.5 font-medium text-[#011627]">
                      SOC 2 Type II
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">In progress</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Prose>
              If you need a DPA or help with a vendor security questionnaire, reach
              out below.
            </Prose>
          </section>

          {/* ── Security Contact ── */}
          <section className="mt-14">
            <SectionHeading id="contact">Security contact</SectionHeading>
            <Prose>
              Security questions, vendor questionnaires, vulnerability reports:
            </Prose>
            <div className="mt-4 rounded-xl border border-slate-200/70 bg-white/80 px-4 py-3">
              <div className="text-[14px] font-medium text-[#011627]">
                {securityContact.name}
              </div>
              <a
                href={`mailto:${securityContact.email}`}
                className="text-[13px] text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-[#011627]"
              >
                {securityContact.email}
              </a>
            </div>
          </section>

        </main>

        <div className="mx-auto w-full max-w-5xl px-6 pb-16 md:px-8">
          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
