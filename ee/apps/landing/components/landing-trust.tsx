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
              OpenWork is a local-first, self-hostable AI work platform. Your code,
              credentials, and prompts stay on infrastructure you control. This page
              describes how we handle data, what third parties are involved, and how to
              reach us for security questions.
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
            <SectionHeading id="deployment">Deployment Model</SectionHeading>
            <Prose>
              OpenWork ships as a self-hosted desktop application that runs entirely on
              your infrastructure. Your team controls the servers, the LLM gateway, and
              the authentication layer.
            </Prose>
            <ul className="mt-4 space-y-2.5 text-[14px] leading-relaxed text-slate-600">
              <Bullet>
                <strong>Desktop app</strong> — runs on your servers. No data leaves your
                infrastructure unless you explicitly connect to an LLM provider.
              </Bullet>
              <Bullet>
                <strong>LLM gateway</strong> — bring your own gateway (LiteLLM,
                Cloudflare AI Gateway, etc.). OpenWork does not proxy, store, or inspect
                API traffic.
              </Bullet>
              <Bullet>
                <strong>Authentication</strong> — integrate with your existing SSO / SAML
                provider.
              </Bullet>
            </ul>
          </section>

          {/* ── Data Handling ── */}
          <section className="mt-14">
            <SectionHeading id="data-handling">Data Handling</SectionHeading>
            <Prose>
              In a self-hosted deployment, OpenWork (the company) receives no customer
              data. The table below shows where each data type lives depending on
              deployment mode.
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
            <SectionHeading id="data-residency">Data Residency</SectionHeading>
            <Prose>
              Self-hosted deployments give you full control over data location — region,
              network boundary, and egress policy are all yours. No data is replicated
              outside your environment.
            </Prose>
            <ul className="mt-4 space-y-2.5 text-[14px] leading-relaxed text-slate-600">
              <Bullet>
                You choose where data resides. OpenWork does not impose a region.
              </Bullet>
              <Bullet>
                Provider choice and deployment choice are fully independent — switching
                your LLM provider does not change where data is stored.
              </Bullet>
            </ul>
          </section>

          {/* ── Subprocessors ── */}
          <section className="mt-14">
            <SectionHeading id="subprocessors">Subprocessors</SectionHeading>
            <Prose>
              The vendors listed below are used by the OpenWork website and optional
              cloud service.{" "}
              <strong>
                In a self-hosted deployment, OpenWork introduces zero third-party
                subprocessors into your environment.
              </strong>
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
            <SectionHeading id="incident-response">Incident Response</SectionHeading>
            <Prose>
              Security issues can be reported privately via email or through a GitHub
              issue. We commit to the following response times:
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
              Need a DPA or vendor security questionnaire completed? Contact us at the
              address below.
            </Prose>
          </section>

          {/* ── Security Contact ── */}
          <section className="mt-14">
            <SectionHeading id="contact">Security Contact</SectionHeading>
            <Prose>
              For security questions, vendor questionnaires, or to report a
              vulnerability:
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

          <div className="mt-16">
            <SiteFooter />
          </div>
        </main>
      </div>
    </div>
  );
}
