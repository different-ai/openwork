import { homeFaq, type FaqEntry } from "../lib/faq";

type LandingFaqProps = {
  entries?: FaqEntry[];
  /** "product" matches the medium-weight headings of the product pages. */
  tone?: "home" | "product";
};

export function LandingFaq({ entries = homeFaq, tone = "home" }: LandingFaqProps) {
  return (
    <section aria-labelledby="faq-heading">
      <h2
        id="faq-heading"
        className={
          tone === "product"
            ? "mb-8 text-[32px] font-medium leading-[38px] tracking-[-0.03em] text-[var(--lp-ink)]"
            : "mb-10 text-[36px] font-light leading-[42px] tracking-[-0.015em] text-[var(--lp-ink)] md:text-[44px] md:leading-[50px]"
        }
      >
        Frequently asked questions
      </h2>
      <dl className="grid md:grid-cols-2 md:gap-x-12">
        {entries.map((entry) => (
          <div key={entry.question} className="border-t border-[var(--lp-border)] py-6">
            <dt className="mb-2 text-[17px] font-medium text-[var(--lp-ink)]">
              {entry.question}
            </dt>
            <dd className="text-[15px] leading-7 text-[var(--lp-body)]">
              {entry.answer}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
