import { SiteFooter } from "../components/site-footer";
import { SiteNav } from "../components/site-nav";
import { OpenCodeLogo } from "../components/opencode-logo";
import { PaperMeshBackground } from "../components/paper-mesh-background";
import { WaitlistForm } from "../components/waitlist-form";
import { getGithubData } from "../lib/github";

export default async function Home() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";
  return (
    <div className="relative min-h-screen">
      <div
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        aria-hidden
        style={{
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 40%, rgba(0,0,0,0) 100%)",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 40%, rgba(0,0,0,0) 100%)"
        }}
      >
        <PaperMeshBackground opacity={0.4} />
      </div>

      <div className="relative z-10">
        <SiteNav stars={github.stars} callUrl={cal} />

        <main className="pb-24 pt-20">
          <div className="content-max-width px-6">
          <div className="animate-fade-up">
            <h1 className="mb-4 max-w-4xl text-5xl font-bold tracking-tight md:text-6xl">
              The team layer for your existing agent setup.
            </h1>
            <p className="mb-10 max-w-4xl text-xl font-medium leading-relaxed text-gray-900/80">
              Whether you&apos;re using Claude Code, Codex, OpenCode, or your own
              stack, OpenWork turns it into a shareable desktop app your
              non-technical coworkers can use.
            </p>
          </div>

          <div className="mb-10 flex flex-wrap items-center gap-3">
            <a
              href={github.downloads.macos}
              className="doc-button"
              rel="noreferrer"
              target="_blank"
            >
              Download for macOS
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
            </a>
            <div className="ml-2 flex gap-4">
              <a
                href="/download#windows"
                className="text-[15px] font-medium text-gray-900/60 transition hover:text-gray-900"
              >
                Windows <span className="alpha-tag ml-1 border-gray-900/10 text-gray-900/60">Alpha</span>
              </a>
              <a
                href="/download#linux"
                className="text-[15px] font-medium text-gray-900/60 transition hover:text-gray-900"
              >
                Linux <span className="alpha-tag ml-1 border-gray-900/10 text-gray-900/60">Alpha</span>
              </a>
            </div>
          </div>

          <div className="group relative mb-2 mt-8">
            <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl transition-transform duration-500 group-hover:scale-[1.01] ring-1 ring-black/5">
              <video
                autoPlay
                loop
                muted
                playsInline
                className="w-full block"
              >
                <source src="/app-demo.mp4" type="video/mp4" />
              </video>
            </div>
          </div>

          <div className="mb-16 flex flex-wrap items-center gap-2 text-[14px] text-gray-700">
            <span className="font-semibold text-gray-900">Powered by</span>
            <a
              href="https://opencode.ai"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center"
              aria-label="opencode.ai"
            >
              <OpenCodeLogo className="h-3 w-auto" />
            </a>
          </div>

          <section id="install">
            <h2 className="mb-6 text-2xl font-bold md:text-3xl">Getting started</h2>
            <p className="mb-8 text-base text-gray-700">
              The OpenWork app is available on macOS, Windows, and Linux.
            </p>

            <div className="space-y-12">
              <div className="flex gap-6">
                <div className="step-circle shrink-0">1</div>
                <div className="space-y-4">
                  <h3 className="text-base font-bold">
                    Download and install the OpenWork app
                  </h3>
                  <p className="text-[15px] text-gray-700">
                    Stable release for macOS. Windows and Linux builds are
                    available in alpha.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      href={github.downloads.macos}
                      className="doc-button"
                      rel="noreferrer"
                      target="_blank"
                    >
                      Download for macOS
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                        />
                      </svg>
                    </a>
                    <div className="ml-2 flex gap-4">
                      <a
                        href="/download#windows"
                        className="text-[15px] text-gray-700 transition hover:text-black"
                      >
                        Windows <span className="alpha-tag ml-1">Alpha</span>
                      </a>
                      <a
                        href="/download#linux"
                        className="text-[15px] text-gray-700 transition hover:text-black"
                      >
                        Linux <span className="alpha-tag ml-1">Alpha</span>
                      </a>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-6">
                <div className="step-circle shrink-0">2</div>
                <div className="w-full space-y-4">
                  <h3 className="text-base font-bold">Send your first message</h3>
                  <p className="text-[15px] text-gray-700">
                    Start instantly. No registration is required to begin using
                    basic models on your machine. Try these examples:
                  </p>

                  <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-3">
                    <div className="flex flex-col gap-3 rounded-xl border border-sky-100 bg-white/90 p-4 shadow-sm ring-1 ring-sky-100/50">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-700 shadow-sm">
                        <svg
                          viewBox="0 0 64 64"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          aria-hidden="true"
                        >
                          <rect x="10" y="26" width="44" height="18" rx="4" />
                          <rect x="14" y="18" width="12" height="10" rx="3" />
                          <rect x="38" y="18" width="12" height="10" rx="3" />
                          <path d="M16 44v6" />
                          <path d="M48 44v6" />
                        </svg>
                      </span>
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-sky-700">
                        Browser task
                      </span>
                      <p className="text-[14px] font-medium leading-relaxed text-gray-900">
                        "Open Chrome and find me a green couch on Facebook
                        Marketplace."
                      </p>
                    </div>
                    <div className="flex flex-col gap-3 rounded-xl border border-violet-100 bg-white/90 p-4 shadow-sm ring-1 ring-violet-100/50">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50 text-violet-700 shadow-sm">
                        <svg
                          viewBox="0 0 64 64"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          aria-hidden="true"
                        >
                          <path d="M10 44h44" />
                          <path d="M16 38l10-18 12 14 10-20" />
                          <circle cx="26" cy="20" r="3" />
                          <circle cx="38" cy="34" r="3" />
                        </svg>
                      </span>
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">
                        Notion update
                      </span>
                      <p className="text-[14px] font-medium leading-relaxed text-gray-900">
                        "Go on Notion and update this CRM entry for me."
                      </p>
                    </div>
                    <div className="flex flex-col gap-3 rounded-xl border border-emerald-100 bg-white/90 p-4 shadow-sm ring-1 ring-emerald-100/50">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 shadow-sm">
                        <svg
                          viewBox="0 0 64 64"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          aria-hidden="true"
                        >
                          <rect x="16" y="14" width="32" height="36" rx="4" />
                          <path d="M22 24h20" />
                          <path d="M22 32h20" />
                          <path d="M22 40h14" />
                        </svg>
                      </span>
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                        CRM action
                      </span>
                      <p className="text-[14px] font-medium leading-relaxed text-gray-900">
                        "Update the CRM with this information."
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <hr />

          <section id="capabilities" className="py-12">
            <h2 className="mb-10 text-2xl font-bold md:text-3xl">Work with the OpenWork app</h2>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
              <div className="feature-card border-sky-100 bg-white/90 ring-1 ring-sky-100/60">
                <span className="mb-3 inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-sky-700">
                  Productivity
                </span>
                <h4 className="mb-2 text-[15px] font-bold">
                  Multitask across projects
                </h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Run multiple independent threads in parallel and switch
                  context instantly between browser tasks and local file work.
                </p>
              </div>
              <div className="feature-card border-violet-100 bg-white/90 ring-1 ring-violet-100/60">
                <span className="mb-3 inline-flex rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-violet-700">
                  Automation
                </span>
                <h4 className="mb-2 text-[15px] font-bold">Automations</h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Run any prompt on a schedule or trigger it automatically. Set
                  it once and let it handle itself.
                </p>
              </div>
              <div className="feature-card border-emerald-100 bg-white/90 ring-1 ring-emerald-100/60">
                <span className="mb-3 inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  Reuse
                </span>
                <h4 className="mb-2 text-[15px] font-bold">Skills support</h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Turn any complex workflow into a reusable skill. Share them
                  with your team so they can run automations with one click.
                </p>
              </div>
              <div className="feature-card border-amber-100 bg-white/90 ring-1 ring-amber-100/60">
                <span className="mb-3 inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                  Collaboration
                </span>
                <h4 className="mb-2 text-[15px] font-bold">Slack-native agents</h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Bring OpenWork into Slack threads. Mention the agent, watch
                  progress stream in real time, and keep the whole team in the
                  loop.
                </p>
              </div>
            </div>
          </section>

          <hr />

          <section id="cloud" className="py-12">
            <h2 className="mb-2 text-2xl font-bold md:text-3xl">
              Automate your entire company, safely
            </h2>
            <p className="mb-8 text-base leading-relaxed text-gray-700">
              OpenWork Cloud runs your automations so you don&apos;t have to
              manage infrastructure. Give every team secure access to the
              workflows they need, with clear controls and zero ops overhead.
            </p>

            <div className="mb-10 grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
              <div className="feature-card border-blue-100 bg-blue-50/50">
                <span className="mb-3 inline-flex rounded-full border border-blue-200 bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-blue-700">
                  Team ready
                </span>
                <h4 className="mb-2 text-[15px] font-bold">
                  Hosted for your team
                </h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  No servers to maintain. We handle the infrastructure so
                  your team can focus on the work.
                </p>
              </div>
              <div className="feature-card border-emerald-100 bg-emerald-50/50">
                <span className="mb-3 inline-flex rounded-full border border-emerald-200 bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  Safe by default
                </span>
                <h4 className="mb-2 text-[15px] font-bold">
                  Permissioned &amp; auditable
                </h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Every agent action is logged. Set clear boundaries for what
                  agents can and cannot do.
                </p>
              </div>
              <div className="feature-card border-amber-100 bg-amber-50/50">
                <span className="mb-3 inline-flex rounded-full border border-amber-200 bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                  Practical onboarding
                </span>
                <h4 className="mb-2 text-[15px] font-bold">
                  Free automation series
                </h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Step-by-step guides on safely automating ops, sales, support,
                  and more. Delivered to your inbox.
                </p>
              </div>
            </div>

            <div className="mb-6">
              <a href="/den" className="doc-button">
                Explore den
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M14 5l7 7m0 0l-7 7m7-7H3"
                  />
                </svg>
              </a>
            </div>
          </section>

          <hr />

          <section id="faq" className="py-12">
            <h2 className="mb-10 text-2xl font-bold md:text-3xl">FAQ</h2>
            <div className="space-y-12">
              <div>
                <h4 className="mb-2 text-[15px] font-bold">
                  What&apos;s the difference between OpenWork and regular chat?
                </h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Regular chat gives you text answers. OpenWork can perform
                  actions like creating files, editing folders, and running
                  browser commands on your local machine, after you approve
                  them.
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-[15px] font-bold">Is it free?</h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Yes. OpenWork is open source. You can download and use it for
                  free using free models on your machine. You only pay for API
                  usage if you choose to connect paid cloud models.
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-[15px] font-bold">
                  Can I share automations with my team?
                </h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Yes. Package any workflow as a skill and share it. Your
                  coworkers can install and run it on their own machines
                  instantly.
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-[15px] font-bold">Is it safe?</h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  OpenWork runs locally. It cannot access files or run commands
                  without your permission. You see a clear plan before any
                  action is taken.
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-[15px] font-bold">
                  Can I use it with Slack, Telegram, or WhatsApp?
                </h4>
                <p className="text-[15px] leading-relaxed text-gray-700">
                  Yes. Once it is running somewhere, you can keep requests
                  flowing from Slack, Telegram, or WhatsApp and let OpenWork
                  carry them out.
                </p>
              </div>
            </div>
          </section>

          <hr />

          <section id="compatibility" className="py-12">
            <h2 className="mb-3 text-2xl font-bold md:text-3xl">Compatibility</h2>
            <p className="mb-8 text-base leading-relaxed text-gray-700">
              OpenWork connects to your existing setup so you can ship team-ready
              workflows without rebuilding from scratch.
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="feature-card flex items-center justify-between gap-4 bg-white/80">
                <h4 className="text-[15px] font-semibold text-gray-900">Claude Code</h4>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] font-semibold text-emerald-700">
                  Full compatibility
                </span>
              </div>

              <div className="feature-card flex items-center justify-between gap-4 bg-white/80">
                <h4 className="text-[15px] font-semibold text-gray-900">OpenCode</h4>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] font-semibold text-emerald-700">
                  Full compatibility
                </span>
              </div>

              <div className="feature-card flex items-center justify-between gap-4 bg-white/80">
                <h4 className="text-[15px] font-semibold text-gray-900">Codex</h4>
                <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[12px] font-semibold text-amber-700">
                  Partial compatibility
                </span>
              </div>

              <div className="feature-card flex items-center justify-between gap-4 bg-white/80">
                <h4 className="text-[15px] font-semibold text-gray-900">PI</h4>
                <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[12px] font-semibold text-amber-700">
                  Partial compatibility
                </span>
              </div>
            </div>
          </section>

          <section id="updates" className="pb-8 pt-6">
            <div className="rounded-2xl border border-white/70 bg-white/70 p-6 shadow-lg backdrop-blur-sm">
              <h3 className="mb-2 text-xl font-semibold tracking-tight text-gray-900">
                Keep me in the loop
              </h3>
              <p className="mb-4 max-w-2xl text-[15px] leading-relaxed text-gray-700">
                Get occasional product updates and practical automation guides.
                No spam, just useful drops.
              </p>
              <WaitlistForm />
            </div>
          </section>

          <SiteFooter />
          </div>
        </main>
      </div>
    </div>
  );
}
