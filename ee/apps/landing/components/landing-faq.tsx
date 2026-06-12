import { homeFaq } from "../lib/faq";

export function LandingFaq() {
  return (
    <section aria-labelledby="faq-heading">
      <h2
        id="faq-heading"
        className="mb-10 text-3xl font-medium leading-[1.15] tracking-tight md:text-4xl"
      >
        Frequently asked questions
      </h2>
      <dl className="grid gap-x-12 gap-y-10 md:grid-cols-2">
        {homeFaq.map((entry) => (
          <div key={entry.question}>
            <dt className="mb-2 text-lg font-medium text-[#011627]">
              {entry.question}
            </dt>
            <dd className="text-[15px] leading-7 text-gray-600">
              {entry.answer}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
