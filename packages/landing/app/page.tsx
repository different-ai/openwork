import { SiteFooter } from "../components/site-footer";
import { SiteNav } from "../components/site-nav";
import { OpenCodeLogo } from "../components/opencode-logo";
import { WaitlistForm } from "../components/waitlist-form";
import { getGithubData } from "../lib/github";

export default async function Home() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";
  return (
    <div className="min-h-screen">
      <SiteNav stars={github.stars} callUrl={cal} />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up">
            <h1 className="mb-2 text-4xl font-bold tracking-tight">
              Not just suggestions. Automate your work.
            </h1>
            <p className="mb-8 flex flex-wrap items-center gap-1.5 text-lg font-normal text-gray-500">
              OpenWork is your open-source
              <span className="word-cycle">
                <span>Cowork</span>
                <span>Codex</span>
              </span>
              alternative for teams.
              <span className="sr-only">
                OpenWork is your open-source Cowork alternative for teams.
              </span>
            </p>
          </div>

          <div className="mb-10 space-y-4 text-[15px] leading-relaxed text-gray-700">
            <p>
              OpenWork is a desktop app for working on automation threads in
              parallel, with built-in support for your local tools, files, and
              browser.
            </p>
            <p>
              Get started with free models, connect your ChatGPT account, or use
              any of the 50 other{" "}
              <a
                href="https://opencode.ai/docs/providers/"
                target="_blank"
                rel="noreferrer"
                className="text-black underline underline-offset-4"
              >
                providers
              </a>
              .
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
                href={github.downloads.windows}
                className="text-[13px] text-gray-400 transition hover:text-black"
                rel="noreferrer"
                target="_blank"
              >
                Windows <span className="alpha-tag ml-1">Alpha</span>
              </a>
              <a
                href={github.downloads.linux}
                className="text-[13px] text-gray-400 transition hover:text-black"
                rel="noreferrer"
                target="_blank"
              >
                Linux <span className="alpha-tag ml-1">Alpha</span>
              </a>
            </div>
          </div>

          <div className="group relative mb-6 rounded-2xl border border-gray-100 bg-gradient-to-br from-blue-50 to-orange-50 p-10 shadow-sm">
            <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-2xl transition-transform duration-500 group-hover:scale-[1.01]">
              <video
                autoPlay
                loop
                muted
                playsInline
                className="w-full"
              >
                <source src="/app-demo.mp4" type="video/mp4" />
              </video>
            </div>
          </div>

          <div className="mb-16 flex flex-wrap items-center gap-2 text-[13px] text-gray-500">
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
            <span>Everything from opencode just works.</span>
          </div>

          <section id="install">
            <h2 className="mb-6 text-2xl font-bold">Getting started</h2>
            <p className="mb-8 text-sm text-gray-500">
              The OpenWork app is available on macOS, Windows, and Linux.
            </p>

            <div className="space-y-12">
              <div className="flex gap-6">
                <div className="step-circle shrink-0">1</div>
                <div className="space-y-4">
                  <h3 className="text-[15px] font-bold">
                    Download and install the OpenWork app
                  </h3>
                  <p className="text-[14px] text-gray-600">
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
                        href={github.downloads.windows}
                        className="text-[13px] text-gray-400 transition hover:text-black"
                        rel="noreferrer"
                        target="_blank"
                      >
                        Windows <span className="alpha-tag ml-1">Alpha</span>
                      </a>
                      <a
                        href={github.downloads.linux}
                        className="text-[13px] text-gray-400 transition hover:text-black"
                        rel="noreferrer"
                        target="_blank"
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
                  <h3 className="text-[15px] font-bold">Send your first message</h3>
                  <p className="text-[14px] text-gray-600">
                    Start instantly. No registration is required to begin using
                    basic models on your machine. Try these examples:
                  </p>

                  <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-3">
                    <div className="flex flex-col gap-3 rounded-lg border border-gray-100 bg-gray-50 p-4">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-gray-600 shadow-sm">
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
                      <p className="text-[12px] font-medium italic leading-relaxed text-gray-600">
                        "Open Chrome and find me a green couch on Facebook
                        Marketplace."
                      </p>
                    </div>
                    <div className="flex flex-col gap-3 rounded-lg border border-gray-100 bg-gray-50 p-4">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-gray-600 shadow-sm">
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
                      <p className="text-[12px] font-medium italic leading-relaxed text-gray-600">
                        "Go on Notion and update this CRM entry for me."
                      </p>
                    </div>
                    <div className="flex flex-col gap-3 rounded-lg border border-gray-100 bg-gray-50 p-4">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-gray-600 shadow-sm">
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
                      <p className="text-[12px] font-medium italic leading-relaxed text-gray-600">
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
            <h2 className="mb-10 text-2xl font-bold">Work with the OpenWork app</h2>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
              <div className="feature-card">
                <h4 className="mb-2 text-[14px] font-bold">
                  Multitask across projects
                </h4>
                <p className="text-[13px] leading-relaxed text-gray-500">
                  Run multiple independent threads in parallel and switch
                  context instantly between browser tasks and local file work.
                </p>
              </div>
              <div className="feature-card">
                <h4 className="mb-2 text-[14px] font-bold">Automations</h4>
                <p className="text-[13px] leading-relaxed text-gray-500">
                  Run any prompt on a schedule or trigger it automatically. Set
                  it once and let it handle itself.
                </p>
              </div>
              <div className="feature-card">
                <h4 className="mb-2 text-[14px] font-bold">Skills support</h4>
                <p className="text-[13px] leading-relaxed text-gray-500">
                  Turn any complex workflow into a reusable skill. Share them
                  with your team so they can run automations with one click.
                </p>
              </div>
              <div className="feature-card">
                <h4 className="mb-2 text-[14px] font-bold">Slack-native agents</h4>
                <p className="text-[13px] leading-relaxed text-gray-500">
                  Bring OpenWork into Slack threads. Mention the agent, watch
                  progress stream in real time, and keep the whole team in the
                  loop.
                </p>
              </div>
            </div>
          </section>

          <hr />

          <section id="cloud" className="py-12">
            <h2 className="mb-2 text-2xl font-bold">
              Automate your entire company, safely
            </h2>
            <p className="mb-8 text-[15px] leading-relaxed text-gray-600">
              OpenWork Cloud runs your automations so you don&apos;t have to
              manage infrastructure. Join the waitlist to get early access and
              a free series that walks you through automating every part of
              your business.
            </p>

            <div className="mb-10 grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
              <div className="feature-card">
                <h4 className="mb-2 text-[14px] font-bold">
                  Hosted for your team
                </h4>
                <p className="text-[13px] leading-relaxed text-gray-500">
                  No servers to maintain. We handle the infrastructure so
                  your team can focus on the work.
                </p>
              </div>
              <div className="feature-card">
                <h4 className="mb-2 text-[14px] font-bold">
                  Permissioned &amp; auditable
                </h4>
                <p className="text-[13px] leading-relaxed text-gray-500">
                  Every agent action is logged. Set clear boundaries for what
                  agents can and cannot do.
                </p>
              </div>
              <div className="feature-card">
                <h4 className="mb-2 text-[14px] font-bold">
                  Free automation series
                </h4>
                <p className="text-[13px] leading-relaxed text-gray-500">
                  Step-by-step guides on safely automating ops, sales, support,
                  and more. Delivered to your inbox.
                </p>
              </div>
            </div>

            <div className="mb-6">
              <a href="/den" className="doc-button">
                Explore Den preorder
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

            <WaitlistForm />
          </section>

          <hr />

          <section id="faq" className="py-12">
            <h2 className="mb-10 text-2xl font-bold">FAQ</h2>
            <div className="space-y-12">
              <div>
                <h4 className="mb-2 text-[15px] font-bold">
                  What&apos;s the difference between OpenWork and regular chat?
                </h4>
                <p className="text-[14px] leading-relaxed text-gray-600">
                  Regular chat gives you text answers. OpenWork can perform
                  actions like creating files, editing folders, and running
                  browser commands on your local machine, after you approve
                  them.
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-[15px] font-bold">Is it free?</h4>
                <p className="text-[14px] leading-relaxed text-gray-600">
                  Yes. OpenWork is open source. You can download and use it for
                  free using free models on your machine. You only pay for API
                  usage if you choose to connect paid cloud models.
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-[15px] font-bold">
                  Can I share automations with my team?
                </h4>
                <p className="text-[14px] leading-relaxed text-gray-600">
                  Yes. Package any workflow as a skill and share it. Your
                  coworkers can install and run it on their own machines
                  instantly.
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-[15px] font-bold">Is it safe?</h4>
                <p className="text-[14px] leading-relaxed text-gray-600">
                  OpenWork runs locally. It cannot access files or run commands
                  without your permission. You see a clear plan before any
                  action is taken.
                </p>
              </div>
              <div>
                <h4 className="mb-2 text-[15px] font-bold">
                  Can I use it with Slack, Telegram, or WhatsApp?
                </h4>
                <p className="text-[14px] leading-relaxed text-gray-600">
                  Yes. Once it is running somewhere, you can keep requests
                  flowing from Slack, Telegram, or WhatsApp and let OpenWork
                  carry them out.
                </p>
              </div>
            </div>
          </section>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
