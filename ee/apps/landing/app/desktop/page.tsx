import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Folder } from "lucide-react";

import { DownloadLink } from "../../components/download-link";
import { LandingFaq } from "../../components/landing-faq";
import { BrandLogo } from "../../components/lp-brand-logos";
import { LpCopyIcon } from "../../components/lp-copy";
import { LpDemoDesktop } from "../../components/lp-demo-desktop";
import {
  LpFact,
  LpPreviewFrame,
  LpProductCta,
  LpProductHeading,
  LpProductHero,
  LpProductShell,
  LpStep,
  LpStepCard,
  salesCallHref
} from "../../components/lp-product-page";
import { TerminalMark } from "../../components/lp-service-marks";
import { OpenWorkMark } from "../../components/openwork-mark";
import { StructuredData } from "../../components/structured-data";
import { desktopFaq, faqSchema } from "../../lib/faq";
import { getGithubData } from "../../lib/github";
import { withSocialMetadata } from "../../lib/seo";

const GITHUB_URL = "https://github.com/different-ai/openwork";
const BREW_COMMAND = "brew install --cask openwork";

export const metadata: Metadata = withSocialMetadata({
  title: "OpenWork Desktop — an AI agent for your files, on your computer",
  description:
    "The free, open-source OpenWork desktop app for macOS, Windows and Linux. Chat on your own files with any model. Your files stay on your computer. No account needed.",
  alternates: { canonical: "/desktop" }
});

const desktopSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenWork Desktop",
  description:
    "Free, open-source desktop app for doing work with AI agents on your own files. Runs on macOS, Windows, and Linux with 50+ model providers, local models, and your own API keys.",
  url: "https://openworklabs.com/desktop",
  downloadUrl: "https://openworklabs.com/download",
  applicationCategory: "BusinessApplication",
  operatingSystem: "macOS, Windows, Linux",
  license: "https://opensource.org/licenses/MIT",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD"
  },
  publisher: {
    "@type": "Organization",
    name: "OpenWork",
    url: "https://openworklabs.com"
  }
};

type Platform = { name: string; builds: { label: string; href: string }[]; note: string };

const PLATFORMS: Platform[] = [
  {
    name: "macOS",
    builds: [
      { label: "Apple Silicon", href: "/download/mac-arm64" },
      { label: "Intel", href: "/download/mac-x64" }
    ],
    note: ".dmg"
  },
  {
    name: "Windows",
    builds: [
      { label: "x64", href: "/download/win-x64" },
      { label: "ARM64", href: "/download/win-arm64" }
    ],
    note: ".exe"
  },
  {
    name: "Linux",
    builds: [
      { label: "x64", href: "/download/linux-x64" },
      { label: "ARM64", href: "/download/linux-arm64" }
    ],
    note: ".AppImage"
  }
];

const SIGNED_OUT = [
  "Chat on your files in the folders you allow",
  "Your own models: API keys, a ChatGPT sign-in or a local model",
  "Skills saved in your workspace",
  "Your own MCP servers"
];

const SIGNED_IN = [
  "Automations that run on a schedule",
  "Skills and plugins your team shares",
  "Connections your team shares, such as Gmail or Slack",
  "Dashboards and saved apps"
];

export default async function DesktopPage() {
  const github = await getGithubData();
  const callHref = salesCallHref();

  return (
    <LpProductShell stars={github.stars} callHref={callHref} active="desktop" current="desktop-app" mobilePrimary={{ href: "/download", label: "Download OpenWork" }}>
      <StructuredData data={desktopSchema} />
      <StructuredData data={faqSchema(desktopFaq)} />

      <LpProductHero
        id="desktop-heading"
        label="Desktop App"
        badge="Free and open source"
        lines={["An AI agent for your files.", "On your own computer."]}
        sub="OpenWork runs on Mac, Windows and Linux with the model you choose. Your files stay on your computer. No account needed."
        actions={
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <div className="flex flex-col gap-3 sm:flex-row">
              <DownloadLink className="lp-pill-primary">Download OpenWork</DownloadLink>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="lp-pill-secondary">
                View on GitHub
              </a>
            </div>
            <span className="text-[13px] text-[var(--lp-muted)]">macOS, Windows and Linux.</span>
          </div>
        }
      >
        <LpPreviewFrame label="OpenWork desktop app preview" tall>
          <LpDemoDesktop />
        </LpPreviewFrame>
        <p className="mt-3 text-[13px] text-[var(--lp-muted)]">
          A working preview. Open a session, the Library or Automations.
        </p>
      </LpProductHero>

      <section aria-label="How to run your first task" className="mt-16 grid gap-6 md:mt-[72px] md:grid-cols-3">
        <LpStep number="01" title="Pick a folder">
          <LpStepCard>
            <span className="flex items-center gap-2 text-sm font-medium text-[#111827]">
              <Folder size={16} strokeWidth={1.5} aria-hidden="true" /> Q3 launch
            </span>
            <span className="mono text-xs text-[#6B7280]">~/Documents/Q3 launch</span>
            <span className="text-xs text-[#047857]">OpenWork only works in folders you allow</span>
          </LpStepCard>
        </LpStep>
        <LpStep number="02" title="Choose a model">
          <LpStepCard>
            <ModelRow mark={<BrandLogo name="openai" className="h-4 w-4 text-[#111]" />} label="Sign in with ChatGPT" />
            <ModelRow mark={<BrandLogo name="anthropic" className="h-4 w-4 text-[#191919]" />} label="Add an API key" />
            <ModelRow mark={<TerminalMark className="h-4 w-4" />} label="Use a local model" />
          </LpStepCard>
        </LpStep>
        <LpStep number="03" title="Run a task">
          <LpStepCard mono>
            <span className="text-[var(--lp-ink)]">&gt; Summarize this folder</span>
            <span className="text-[var(--lp-muted)]">Read 14 files in Q3 launch</span>
            <span className="text-[#047857]">✓ Wrote summary.md</span>
          </LpStepCard>
        </LpStep>
      </section>

      <section aria-labelledby="features-heading" className="mt-24 md:mt-32">
        <LpProductHeading
          id="features-heading"
          label="What it does"
          lines={["Ask for the work.", "The agent does it on your files."]}
        />
        <div className="mt-10 grid gap-8 md:grid-cols-3">
          <LpFact title="Chat on your files">
            Ask for a summary, a draft or a cleanup. The agent reads and writes in the folders you allow.
          </LpFact>
          <LpFact title="Skills and plugins">
            Save a way of working as a skill and reuse it. Anthropic-compatible plugins and skills work as they are.
          </LpFact>
          <LpFact title="Automations">
            Put a task on a schedule, such as an inbox triage every morning. Each run is a chat you can open afterwards. Needs a sign-in.
          </LpFact>
          <LpFact title="A built-in browser">
            The agent opens pages, clicks, fills forms and reads what is there. Take over at any time to sign in yourself.
          </LpFact>
          <LpFact title="Any model">
            Claude, GPT, Gemini, Mistral, or a local model through Ollama or LM Studio. 50+ providers.
          </LpFact>
          <LpFact title="Your tools">
            Add MCP servers for the services you use, or connect your team&apos;s through the MCP Gateway.
          </LpFact>
        </div>
      </section>

      <section aria-labelledby="local-heading" className="mt-24 md:mt-28">
        <LpProductHeading
          id="local-heading"
          label="Local first"
          lines={["Your files stay on your computer."]}
          aside="Prompts go straight from the app to the model provider you choose. With a local model, they stay on your computer too."
          size="small"
        />
        <div className="mt-8 flex flex-col items-stretch gap-6 rounded-[20px] bg-[var(--lp-tonal)] p-5 md:p-8 lg:flex-row lg:items-center lg:gap-0">
          <div className="flex flex-col rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_12px_24px_-16px_rgba(1,22,39,0.2)] lg:w-[400px] lg:shrink-0">
            <div className="flex items-center justify-between border-b border-[#F0F1F3] px-4 py-3.5">
              <span className="flex items-center gap-2 text-sm font-medium text-[#111827]">
                <OpenWorkMark className="h-3.5 w-[18px]" /> OpenWork
              </span>
              <span className="text-[11px] text-[#6B7280]">Your computer</span>
            </div>
            <ul className="flex flex-col px-4">
              <LocalRow label="Files" value="~/Documents/Q3 launch" />
              <LocalRow label="Skills" value="Weekly update, Invoice cleanup" />
              <LocalRow label="Chats" value="Saved on this computer" last />
            </ul>
          </div>
          <div className="flex items-center justify-center lg:flex-1" aria-hidden="true">
            <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" />
            <span className="mono rounded-full bg-white px-3 py-1.5 text-[11px] text-[var(--lp-ink)] shadow-[0_0_0_1px_rgba(1,22,39,0.1)]">
              prompts only
            </span>
            <span className="hidden h-px flex-1 bg-[#9FB0C3] lg:block" />
          </div>
          <ul className="flex flex-col gap-2.5 lg:w-[380px] lg:shrink-0" aria-label="Where prompts can go">
            <DestinationRow mark={<BrandLogo name="anthropic" className="h-4 w-4 text-[#191919]" />} name="Anthropic" detail="With your API key" />
            <DestinationRow mark={<BrandLogo name="openai" className="h-4 w-4 text-[#111]" />} name="ChatGPT" detail="With your sign-in" />
            <DestinationRow mark={<TerminalMark className="h-4 w-4" />} name="Ollama" detail="On this computer. Nothing leaves it." local />
          </ul>
        </div>
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          <LpFact title="No account needed">
            Download it, pick a folder and start. Signing in is optional and adds what your team shares.
          </LpFact>
          <LpFact title="Only the folders you allow">
            OpenWork only works in the folders you authorize. You choose them when you start.
          </LpFact>
          <LpFact title="Open source">
            The desktop app is MIT licensed.{" "}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-[var(--lp-ink)] underline underline-offset-4">
              Read the code
            </a>
            , audit it or fork it.
          </LpFact>
        </div>
      </section>

      <section aria-labelledby="account-heading" className="mt-24 md:mt-28">
        <LpProductHeading
          id="account-heading"
          label="Signing in"
          lines={["Everything local works signed out."]}
          aside="Signing in to a model provider is separate from signing in to OpenWork Cloud."
          size="small"
        />
        <div className="mt-8 grid gap-x-12 gap-y-10 md:grid-cols-2">
          <CheckList title="Works signed out" items={SIGNED_OUT} />
          <CheckList title="With an OpenWork Cloud sign-in" items={SIGNED_IN} />
        </div>
      </section>

      <section aria-labelledby="install-heading" className="mt-24 md:mt-28">
        <LpProductHeading
          id="install-heading"
          label="Install"
          lines={["Mac, Windows and Linux."]}
          aside={
            <>
              Each link gets the installer from the latest stable release.{" "}
              <Link href="/download" className="text-[var(--lp-ink)] underline underline-offset-4">
                All downloads
              </Link>
            </>
          }
          size="small"
        />
        <ul className="mt-8 border-b border-[var(--lp-border)]">
          {PLATFORMS.map((platform) => (
            <li key={platform.name} className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--lp-border)] py-3">
              <span className="w-[76px] shrink-0 text-sm font-medium text-[#111827] sm:w-[104px]">{platform.name}</span>
              <span className="flex flex-1 flex-wrap items-center gap-2">
                {platform.builds.map((build) => (
                  <a
                    key={build.href}
                    href={build.href}
                    aria-label={`Download OpenWork for ${platform.name} ${build.label}`}
                    className="lp-pill-secondary lp-pill-sm"
                  >
                    {build.label}
                  </a>
                ))}
              </span>
              <span className="mono hidden text-xs text-[var(--lp-muted)] sm:block">{platform.note}</span>
            </li>
          ))}
          <li className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--lp-border)] py-3">
            <span className="w-[76px] shrink-0 text-sm font-medium text-[#111827] sm:w-[104px]">Homebrew</span>
            <span className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-[#F5F7FA] pl-3 sm:max-w-[360px]">
              <code className="mono min-w-0 flex-1 truncate text-[13px] text-[#1F2937]">{BREW_COMMAND}</code>
              <LpCopyIcon value={BREW_COMMAND} label="Copy the Homebrew command" />
            </span>
            <span className="mono hidden text-xs text-[var(--lp-muted)] sm:block">macOS</span>
          </li>
        </ul>
      </section>

      <section aria-labelledby="teams-heading" className="mt-24 md:mt-28">
        <LpProductHeading id="teams-heading" label="For teams" lines={["One person today. The whole company later."]} size="small" />
        <div className="mt-8 grid gap-8 md:grid-cols-3">
          <LpFact title="Share skills and connections">
            Publish a skill or a connection once and every teammate&apos;s app has it.{" "}
            <FactLink href="/connect">MCP Gateway</FactLink>
          </LpFact>
          <LpFact title="Provide the models">
            Connect your providers once and choose who can use each model. Nobody pastes a key.{" "}
            <FactLink href="/ai-gateway">AI Gateway</FactLink>
          </LpFact>
          <LpFact title="Roll it out with your MDM">
            Deploy the signed enterprise build with the tools you already use. It requires sign-in and has its own update channel.{" "}
            <FactLink href="/enterprise">Enterprise</FactLink>
          </LpFact>
        </div>
      </section>

      <div className="mt-24 md:mt-28">
        <LandingFaq entries={desktopFaq} tone="product" />
      </div>

      <LpProductCta heading="Download it and run your first task." note="Free and open source. No account needed.">
        <div className="flex flex-col gap-3 sm:flex-row">
          <DownloadLink className="lp-pill-primary">Download OpenWork</DownloadLink>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="lp-pill-secondary">
            View on GitHub
          </a>
        </div>
      </LpProductCta>
    </LpProductShell>
  );
}

function ModelRow({ mark, label }: { mark: ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-2.5 text-[13px] text-[#111827]">
      {mark}
      {label}
    </span>
  );
}

function LocalRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <li className={`flex min-h-[44px] items-center gap-3 text-[13px] ${last ? "" : "border-b border-[#F0F1F3]"}`}>
      <span className="w-12 shrink-0 text-[#6B7280]">{label}</span>
      <span className="min-w-0 truncate text-[#111827]">{value}</span>
    </li>
  );
}

function DestinationRow({ mark, name, detail, local = false }: { mark: ReactNode; name: string; detail: string; local?: boolean }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-xl bg-white px-4 py-3.5 shadow-[0_0_0_1px_rgba(1,22,39,0.08)]">
      <span className="flex items-center gap-2">
        {mark}
        <span className="text-[13px] font-medium text-[#111827]">{name}</span>
      </span>
      <span className={`text-xs ${local ? "text-[#047857]" : "text-[#6B7280]"}`}>{detail}</span>
    </li>
  );
}

function CheckList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="text-base font-medium tracking-[-0.01em]">{title}</h3>
      <ul className="mt-4 border-b border-[var(--lp-border)]">
        {items.map((item) => (
          <li key={item} className="flex min-h-12 items-center gap-3 border-t border-[var(--lp-border)] py-2.5 text-sm text-[var(--lp-body)]">
            <span className="text-[#047857]" aria-hidden="true">
              ✓
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FactLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="whitespace-nowrap text-[var(--lp-ink)] underline underline-offset-4">
      {children}
    </a>
  );
}
