import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork - Starter Success",
  description: "Thanks for pre-ordering OpenWork Team Starter.",
};

export default async function StarterSuccessPage() {
  const github = await getGithubData();
  const calBase = process.env.NEXT_PUBLIC_CAL_URL ?? "";
  const calHref = (() => {
    if (!calBase) return "/enterprise#book";
    try {
      const url = new URL(calBase);
      url.searchParams.set("source", "starter-success");
      url.searchParams.set("notes", "Paid customer: OpenWork Team Starter (12 months). Priority onboarding requested.");
      url.searchParams.set("description", "Paid customer - Team Starter (12 months). Please prioritize onboarding.");
      return url.toString();
    } catch {
      return calBase;
    }
  })();

  return (
    <div className="min-h-screen">
      <SiteNav stars={github.stars} />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <section className="animate-fade-up">
            <div className="mb-4 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
              starter confirmed
            </div>

            <h1 className="mb-4 text-4xl font-bold tracking-tight">
              Thank you. You&apos;re in.
            </h1>

            <p className="max-w-2xl text-[16px] leading-relaxed text-gray-700">
              You&apos;re on track for getting access to OpenWork Hosted in 7 days.
            </p>
          </section>

          <section className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="feature-card">
              <h2 className="mb-2 text-[15px] font-bold">What happens next</h2>
              <ul className="space-y-2 text-[14px] leading-relaxed text-gray-600">
                <li>- We review your team setup and use case.</li>
                <li>- We send rollout details for teams up to 10 people.</li>
                <li>- You get early access as hosted workers go live.</li>
              </ul>
            </div>

            <div className="feature-card bg-gradient-to-br from-blue-50 to-orange-50">
              <h2 className="mb-2 text-[15px] font-bold">Want to accelerate?</h2>
              <p className="mb-4 text-[14px] leading-relaxed text-gray-600">
                Schedule a call with the founder to accelerate and share your
                use case.
              </p>
              <a href={calHref} className="doc-button">
                Schedule founder call
              </a>
            </div>
          </section>

          <div className="mt-10 rounded-xl border border-gray-100 bg-white p-5 text-[13px] text-gray-500">
            OpenWork stays open source, runs in any environment, and works with
            any model.
          </div>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
