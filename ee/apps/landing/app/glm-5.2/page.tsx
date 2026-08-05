import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { StructuredData } from "../../components/structured-data";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph } from "../../lib/seo";

const CLOUD_SIGNUP_URL =
  "https://app.micxlabs.com?mode=sign-up&intent=models";
const CALENDAR_URL =
  "https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ0M6zjfdm9ntqokfGCWovfuM21J9C2sqB9R6E1v_plXo8MqKswICQET7-ncV4dOVM5W8pFn1RFM";
const CHANGELOG_URL = "/docs/changelog";
const DOWNLOAD_URL = "/download";

const glmSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Micx — GLM 5.2",
  description:
    "GLM 5.2 is available through Micx Models with 2x usage. Run real agent work on an open model at a fraction of the cost.",
  url: "https://micxlabs.com/glm-5.2",
  applicationCategory: "BusinessApplication",
  operatingSystem: "macOS, Windows, Linux",
  offers: {
    "@type": "Offer",
    price: "10",
    priceCurrency: "USD",
    url: CLOUD_SIGNUP_URL
  },
  publisher: {
    "@type": "Organization",
    name: "Micx",
    url: "https://micxlabs.com"
  }
};

export const metadata = {
  title: "GLM 5.2 is now in Micx — with 2x usage",
  description:
    "GLM 5.2 is available through Micx Models, and we're doubling your usage so you can run real agent work on an open model at a fraction of the cost.",
  alternates: {
    canonical: "/glm-5.2"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://micxlabs.com/glm-5.2"
  }
};

const features = [
  {
    title: "Micx Models — 2x usage",
    body: "GLM 5.2 is available through Micx Models, our managed way to access leading OSS models without bringing your own keys. We're doubling your usage so your team can run real agent work at a fraction of the cost.",
    color: "border-sky-100 bg-sky-50/60"
  },
  {
    title: "Run your day from chat",
    body: "Orchestrate Micx fully through chat. Tasks now organize into groups — In progress, Done, Requires attention — and you can move them by asking, not clicking. Try: \"Put this session in In progress now.\"",
    color: "border-violet-100 bg-violet-50/50"
  },
  {
    title: "Split screen",
    body: "Two windows, side by side. Keep a reference open on the left while you work on the right. Less tab-switching, more shipping.",
    color: "border-emerald-100 bg-emerald-50/60"
  },
  {
    title: "Voice mode",
    body: "Control the Micx UI by voice. Talk through a task, navigate panels, and drive the agent without touching the keyboard.",
    color: "border-amber-100 bg-amber-50/50"
  },
  {
    title: "Advanced analytics on Micx Cloud",
    body: "The cloud platform now has advanced analytics — usage, activity, and team behavior in one view. If you're running Micx across a team, this is your new dashboard.",
    color: "border-rose-100 bg-rose-50/50"
  }
];

export default async function GlmLanding() {
  const github = await getGithubData();

  return (
    <div className="min-h-screen">
      <StructuredData data={glmSchema} />
      <SiteNav
        stars={github.stars}
        downloadHref={github.downloads.macos}
      />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          {/* Hero */}
          <div className="animate-fade-up max-w-3xl">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              New in Micx
            </div>
            <h1 className="mb-4 text-4xl font-bold tracking-tight md:text-5xl">
              GLM 5.2, now in the API — with 2x usage
            </h1>
            <p className="mb-6 text-[17px] leading-relaxed text-gray-700">
              GLM 5.2 is available today through Micx Models, and we&apos;re
              doubling your usage so you and your team can run real agent work on
              an open model at a fraction of the cost. Micx Models is our
              managed way to get access to leading OSS models without bringing
              your own keys — and we&apos;re continuing to expand the lineup.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={CLOUD_SIGNUP_URL}
                target="_blank"
                rel="noreferrer"
                className="doc-button inline-flex"
              >
                Try GLM 5.2 in Micx →
              </a>
              <a href={CHANGELOG_URL} className="secondary-button inline-flex" target="_blank" rel="noreferrer">
                See the full changelog
              </a>
            </div>
          </div>

          {/* Feature grid */}
          <section className="my-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {features.map((f) => (
              <div key={f.title} className={`feature-card ${f.color}`}>
                <span className="mb-2 block text-[16px] font-semibold text-gray-900">
                  {f.title}
                </span>
                <p className="text-[14px] leading-relaxed text-gray-700">{f.body}</p>
              </div>
            ))}
          </section>

          {/* What to try first */}
          <section className="landing-shell my-12 rounded-2xl p-8">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              What to try first
            </div>
            <h2 className="mb-3 text-2xl font-bold tracking-tight">
              Switch to GLM 5.2 and ask the chat to organize your tasks
            </h2>
            <p className="mb-6 text-[15px] leading-relaxed text-gray-700">
              Open Micx, switch to GLM 5.2 from the model picker, and ask the
              chat to organize your tasks. No setup, no keys — Micx Models
              handles the rest.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={CLOUD_SIGNUP_URL}
                target="_blank"
                rel="noreferrer"
                className="doc-button inline-flex"
              >
                Try GLM 5.2 in Micx →
              </a>
              <a href={DOWNLOAD_URL} className="secondary-button inline-flex">
                Download the app
              </a>
            </div>
          </section>

          {/* How it works — conversion funnel */}
          <section className="my-12">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              How it works
            </div>
            <h2 className="mb-6 text-2xl font-bold tracking-tight">
              From signup to GLM 5.2 in three steps
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="feature-card">
                <span className="step-circle mb-3">1</span>
                <span className="mb-2 block text-[16px] font-semibold text-gray-900">
                  Sign up
                </span>
                <p className="text-[14px] text-gray-700">
                  Create a free Micx Cloud account. After signup, you land
                  directly on the Micx Models page.
                </p>
              </div>
              <div className="feature-card">
                <span className="step-circle mb-3">2</span>
                <span className="mb-2 block text-[16px] font-semibold text-gray-900">
                  Subscribe
                </span>
                <p className="text-[14px] text-gray-700">
                  Subscribe to Micx Models ($10/user/mo). GLM 5.2 is included
                  with 2x usage. One click to Stripe checkout.
                </p>
              </div>
              <div className="feature-card">
                <span className="step-circle mb-3">3</span>
                <span className="mb-2 block text-[16px] font-semibold text-gray-900">
                  Open the app
                </span>
                <p className="text-[14px] text-gray-700">
                  Launch the desktop app, sign in, and switch to GLM 5.2 from the
                  model picker. Don&apos;t have the app? Download it for macOS,
                  Windows, or Linux.
                </p>
              </div>
            </div>
          </section>

          {/* Final CTA bar */}
          <section className="my-12 flex flex-col items-center gap-4 rounded-2xl border border-gray-200 bg-white/60 p-8 text-center">
            <h2 className="text-2xl font-bold tracking-tight">
              Run real agent work on GLM 5.2 today
            </h2>
            <p className="max-w-xl text-[15px] text-gray-600">
              Open source, 50+ models, and managed OSS model access — all in one
              app. Start free, subscribe to Micx Models, and get 2x usage on
              GLM 5.2.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <a
                href={CLOUD_SIGNUP_URL}
                target="_blank"
                rel="noreferrer"
                className="doc-button inline-flex"
              >
                Try GLM 5.2 in Micx →
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
