import { homeFaq } from "../lib/faq";

export function LandingFaq() {
  return (
    <section aria-labelledby="faq-heading">
      <h2
        id="faq-heading"
        className="mb-10 text-[36px] font-light leading-[42px] tracking-[-0.015em] text-[var(--lp-ink)] md:text-[44px] md:leading-[50px]"
      >
        Frequently asked questions
      </h2>
      <dl className="grid md:grid-cols-2 md:gap-x-12">
        {homeFaq.map((entry) => (
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
