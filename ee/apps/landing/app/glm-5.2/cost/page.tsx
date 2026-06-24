import { SiteFooter } from "../../../components/site-footer";
import { SiteNav } from "../../../components/site-nav";
import { StructuredData } from "../../../components/structured-data";
import { GlmCostCalculator } from "../../../components/glm-cost-calculator";
import { getGithubData } from "../../../lib/github";
import { baseOpenGraph } from "../../../lib/seo";

const CLOUD_SIGNUP_URL =
  "https://app.openworklabs.com?mode=sign-up&intent=models";
const CALENDAR_URL =
  "https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ0M6zjfdm9ntqokfGCWovfuM21J9C2sqB9R6E1v_plXo8MqKswICQET7-ncV4dOVM5W8pFn1RFM";
const DOWNLOAD_URL = "/download";

const costSchema = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "OpenWork — GLM 5.2 cost calculator",
  description:
    "Interactive cost model comparing GLM 5.2 vs Sonnet 4.6 vs Opus 4.8 for AI coworker token spend across teams.",
  url: "https://openworklabs.com/glm-5.2/cost",
  applicationCategory: "BusinessApplication",
  offers: {
    "@type": "Offer",
    price: "10",
    priceCurrency: "USD",
    url: CLOUD_SIGNUP_URL
  },
  publisher: {
    "@type": "Organization",
    name: "OpenWork",
    url: "https://openworklabs.com"
  }
};

export const metadata = {
  title: "GLM 5.2 cost calculator — OpenWork",
  description:
    "Interactive cost model: GLM 5.2 runs ~6.6x cheaper than Opus 4.8 at every usage tier. Drag the sliders and see the savings.",
  alternates: {
    canonical: "/glm-5.2/cost"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/glm-5.2/cost"
  }
};

const ASSUMPTIONS = [
  {
    label: "Tasks / employee / month",
    value: "160",
    detail: "20 working days × 8 agent tasks/day",
  },
  {
    label: "Tokens per task",
    value: "25K in · 6K out",
    detail: "System prompt + tool defs + context + reasoning",
  },
  {
    label: "Moderate tier",
    value: "4M / 1M",
    detail: "per employee / month (in / out)",
  },
  {
    label: "GLM 5.2 list price",
    value: "$0.95 / $3",
    detail: "OpenRouter, per M tokens (in / out)",
  },
  {
    label: "Sonnet 4.6 list price",
    value: "$3 / $15",
    detail: "Anthropic, per M tokens (in / out)",
  },
  {
    label: "Opus 4.8 list price",
    value: "$5 / $25",
    detail: "Anthropic, per M tokens (in / out)",
  },
];

export default async function GlmCostLanding() {
  const github = await getGithubData();

  return (
    <div className="min-h-screen">
      <StructuredData data={costSchema} />
      <SiteNav
        stars={github.stars}
        downloadHref={github.downloads.macos}
      />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up max-w-3xl">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              GLM 5.2 · Cost model
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              AI coworkers don&apos;t reduce spend. They multiply it.
            </h1>
            <p className="mb-6 text-[17px] leading-relaxed text-gray-700">
              An AI coworker is agentic — every task re-sends system prompt, tool
              defs, and accumulated context, plus reasoning on output. As adoption
              climbs from light to heavy use, the <strong>absolute</strong> gap
              between GLM 5.2 and Anthropic-only pricing explodes. Same coworker,
              ~6–7× cheaper, and the savings grow exactly as adoption grows.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={CLOUD_SIGNUP_URL}
                target="_blank"
                rel="noreferrer"
                className="doc-button inline-flex"
              >
                Try GLM 5.2 in OpenWork →
              </a>
              <a href={CALENDAR_URL} target="_blank" rel="noreferrer" className="secondary-button inline-flex">
                Book a call
              </a>
              <a href="/glm-5.2" className="secondary-button inline-flex">
                About GLM 5.2
              </a>
            </div>
          </div>

          <div className="my-12">
            <GlmCostCalculator />
          </div>

          <section className="landing-shell my-12 rounded-3xl p-6 md:p-8">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              Assumptions
            </div>
            <h2 className="mb-6 text-2xl font-bold tracking-tight text-[#011627]">
              How the model is built
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ASSUMPTIONS.map((a) => (
                <div key={a.label} className="rounded-2xl border border-gray-200 bg-white p-4">
                  <div className="text-[12px] font-semibold text-gray-500">{a.label}</div>
                  <div className="mono mt-1 text-[16px] font-bold text-[#011627]">{a.value}</div>
                  <div className="mt-1 text-[12px] leading-snug text-gray-500">{a.detail}</div>
                </div>
              ))}
            </div>
            <p className="mt-5 text-[12px] leading-relaxed text-gray-500">
              Prices are OpenRouter / Anthropic list prices as of Jun 23, 2026. GLM 5.2
              dropped from $1.40/$4.40 a week prior. Token estimates are directional
              for agentic (not chatbot) usage. Actual spend depends on your tasks,
              context length, and model routing.
            </p>
          </section>

          <section className="landing-shell my-12 flex flex-col items-center gap-4 rounded-3xl p-8 text-center">
            <h2 className="text-2xl font-bold tracking-tight text-[#011627]">
              Run real agent work on GLM 5.2 today
            </h2>
            <p className="max-w-xl text-[15px] text-gray-600">
              Open source, 50+ models, and managed OSS model access — all in one app.
              Start free, subscribe to OpenWork Models, and get 2x usage on GLM 5.2.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <a
                href={CLOUD_SIGNUP_URL}
                target="_blank"
                rel="noreferrer"
                className="doc-button inline-flex"
              >
                Try GLM 5.2 in OpenWork →
              </a>
              <a href={CALENDAR_URL} target="_blank" rel="noreferrer" className="secondary-button inline-flex">
                Book a call
              </a>
              <a href={DOWNLOAD_URL} className="secondary-button inline-flex">
                Download the app
              </a>
            </div>
          </section>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
