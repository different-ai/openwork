import Link from "next/link";
import type { ReactNode } from "react";
import { StructuredData } from "./structured-data";

export type GovernanceFaqEntry = { question: string; answer: string };

export function GovernanceFaq({ entries, title }: { entries: GovernanceFaqEntry[]; title: string }) {
  return (
    <section className="governance-section" aria-label={title}>
      <StructuredData data={{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: entries.map(({ question, answer }) => ({ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } })) }} />
      <h2 className="governance-heading">{title}</h2>
      <div className="mt-8 border-b border-[var(--lp-border)]">
        {entries.map(({ question, answer }) => (
          <details key={question} className="group border-t border-[var(--lp-border)] py-2">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-6 py-3 text-base font-medium [&::-webkit-details-marker]:hidden">
              {question}<span aria-hidden="true" className="shrink-0 text-xl transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none">›</span>
            </summary>
            <p className="max-w-[850px] pb-4 pt-2 text-base leading-7 text-[var(--lp-body)]">{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function GovernanceSection({ id, label, title, children }: { id: string; label: string; title: string; children: ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-heading`} className="governance-section scroll-mt-8">
    <div className="governance-split">
      <div><p className="governance-label">{label}</p><h2 id={`${id}-heading`} className="governance-heading mt-3">{title}</h2></div>
      <div className="governance-prose">{children}</div>
    </div>
  </section>;
}

export function GovernanceNextSteps() {
  return <section className="governance-section pb-4">
    <p className="governance-label">From policy to practice</p>
    <h2 className="governance-heading mt-3 max-w-[740px]">Give employees a path they can actually use.</h2>
    <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
      <Link href="/enterprise#book" className="lp-pill-primary">Book a demo</Link>
      <Link href="/enterprise" className="lp-pill-secondary">Explore enterprise deployment</Link>
      <Link href="/pricing" className="lp-pill-secondary">Compare plans</Link>
    </div>
  </section>;
}

export function ModelTrafficPath() {
  return <figure className="mt-10 rounded-[24px] bg-[var(--lp-tonal)] p-6 md:p-10">
    <figcaption className="governance-label">The approved model path</figcaption>
    <ol className="mt-6 grid gap-8 md:grid-cols-3">
      {[
        ["01", "Work on your PC", "OpenWork or OpenCode with the OpenWork plugin. Local files and workspace processing stay on the device."],
        ["02", "Use the AI gateway", "Company sign-in, model permissions, centrally configured providers, and visibility into routed usage."],
        ["03", "Reach your provider", "AWS Bedrock or another approved provider receives model requests, including any context supplied to the model."]
      ].map(([number, title, body]) => <li key={number} className="border-t border-[var(--lp-border)] pt-5">
        <span className="mono text-xs text-[var(--lp-muted)]">{number}</span><h3 className="mt-3 text-lg font-medium">{title}</h3><p className="mt-3 text-sm leading-6 text-[var(--lp-body)]">{body}</p>
      </li>)}
    </ol>
  </figure>;
}
