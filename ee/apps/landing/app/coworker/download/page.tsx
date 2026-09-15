import type { Metadata } from "next";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Info, Laptop } from "lucide-react";
import { CoworkerAppIcon, CoworkerAvatar, CoworkerMark } from "../../../components/coworker-brand";
import { COWORKER, NOTIFY } from "../../../lib/coworker-content";
import "@openwork/ui/coworker.css";
import "./download.css";

// Verified against the published Coworker-specific GitHub release on 2026-09-08.
// Keep the asset pinned: the repository's latest release may be a different product.
const RELEASE = {
  version: "0.1.0-alpha.20260908.1",
  notes: "https://github.com/different-ai/openwork/releases/tag/coworker-v0.1.0-alpha.20260908.1",
  download: "https://github.com/different-ai/openwork/releases/download/coworker-v0.1.0-alpha.20260908.1/open-coworker-mac-arm64-0.1.0-alpha.20260908.1.dmg",
};

const START_STEPS = [
  {
    title: "Install the macOS alpha",
    text: "Read the release notes before installing. Open the Apple Silicon DMG, move Open Coworker to Applications, and launch the app.",
  },
  {
    title: "Give your first coworker a role",
    text: "Choose a researcher, a writing partner, or a role of your own. Start with one clear responsibility and a useful first task.",
  },
  {
    title: "Choose your AI model",
    text: "Use your own provider, or sign in to OpenWork for the models available to your account. Usage follows your provider or plan.",
  },
  {
    title: "Connect only what you need",
    text: "Bring in the apps and shared skills available to you through OpenWork Connect. Authorize the connections your coworker needs before using them.",
  },
];

export const metadata: Metadata = {
  title: "Download Open Coworker for macOS",
  description: "Get the Open Coworker development alpha for Apple Silicon Macs. Find release notes, platform availability, source code, and the steps to get started.",
  alternates: { canonical: "/coworker/download" },
  icons: { icon: "/coworker/app-icon.png", apple: "/coworker/app-icon.png" },
  openGraph: {
    title: "Download Open Coworker for macOS",
    description: "A dedicated desktop app for your AI team. Public development alpha for macOS on Apple Silicon.",
    url: "https://openworklabs.com/coworker/download",
    siteName: "Open Coworker",
    images: ["/coworker/opengraph-image"],
  },
  twitter: { card: "summary_large_image", images: ["/coworker/opengraph-image"] },
};

export default function CoworkerDownloadPage() {
  return (
    <div className="cw-download" data-testid="coworker-download-page">
      <a href="#download-content" className="cw-download-skip">Skip to content</a>
      <header className="cw-download-nav">
        <div className="cw-download-nav-inner">
          <a href={COWORKER.path} className="cw-download-brand">
            <CoworkerMark size={30} />
            <span>{COWORKER.name}</span>
          </a>
          <nav aria-label="Primary">
            <a href="/coworker#how">Try the demo <ArrowUpRight size={15} aria-hidden="true" /></a>
          </nav>
        </div>
      </header>

      <main id="download-content" className="cw-download-main" tabIndex={-1}>
        <section className="cw-download-hero" aria-labelledby="download-title">
          <div className="cw-download-icon"><CoworkerAppIcon /></div>
          <p className="cw-download-eyebrow">Your team, on your desktop</p>
          <h1 id="download-title">Open Coworker for Mac.</h1>
          <p className="cw-download-lead">A home for your AI coworkers. Give them a role, bring your context, and turn the next conversation into useful work.</p>
        </section>

        <div data-testid="coworker-download-availability">
          <section className="cw-download-card" aria-labelledby="download-macos-title">
            <div className="cw-download-card-heading">
              <div className="cw-download-platform-title">
                <span className="cw-download-platform-icon"><Laptop size={25} aria-hidden="true" /></span>
                <div><h2 id="download-macos-title">macOS</h2><p>For Apple Silicon Macs</p></div>
              </div>
              <span className="cw-download-badge">Public alpha</span>
            </div>

            <div className="cw-download-actions">
              <a href={RELEASE.download} className="cw-download-button" aria-describedby="download-alpha-warning">
                <ArrowDownToLine size={18} aria-hidden="true" /> Download macOS alpha
              </a>
              <a href={RELEASE.notes} className="cw-download-text-link">Read release notes <ArrowUpRight size={15} aria-hidden="true" /></a>
            </div>

            <dl className="cw-download-release-details">
              <div><dt>Version</dt><dd>{RELEASE.version}</dd></div>
              <div><dt>Published</dt><dd><time dateTime="2026-09-08">September 8, 2026</time></dd></div>
              <div><dt>Package</dt><dd>DMG / 274 MB / arm64</dd></div>
            </dl>

            <div className="cw-download-warning" id="download-alpha-warning">
              <Info size={18} aria-hidden="true" />
              <p><strong>An early testing build, not a stable release.</strong> This release is signed and notarized. Full native feature verification remains incomplete. Review the release notes before deciding to install.</p>
            </div>
          </section>

          <section className="cw-download-platforms" aria-labelledby="download-platforms-title">
            <h2 id="download-platforms-title">Other platforms</h2>
            <dl>
              <div><dt>Mac with Intel</dt><dd>Not available</dd></div>
              <div><dt>Windows</dt><dd>Not available</dd></div>
              <div><dt>Linux</dt><dd>Not available</dd></div>
            </dl>
            <p>Only the Apple Silicon installer is included in this public release.</p>
          </section>
        </div>

        <section className="cw-download-start" aria-labelledby="download-start-title">
          <div className="cw-download-start-intro">
            <p className="cw-download-eyebrow">Make it your own</p>
            <h2 id="download-start-title">From install<br />to your first task.</h2>
            <p>Start small. One coworker.<br />One thing worth working on.</p>
            <div className="cw-download-companions" aria-hidden="true">
              <CoworkerAvatar name="Researcher" identity="download:researcher" color="blue" glasses="round" size={48} animated={false} gaze={false} motion="quiet" />
              <CoworkerAvatar name="Writing partner" identity="download:writer" color="rose" glasses="square" size={48} animated={false} gaze={false} motion="quiet" />
              <CoworkerAvatar name="Operations partner" identity="download:ops" color="mint" glasses="oval" size={48} animated={false} gaze={false} motion="quiet" />
            </div>
            <a href="/coworker#how" className="cw-download-text-link">Meet them in the demo <ArrowRight size={15} aria-hidden="true" /></a>
          </div>
          <ol className="cw-download-steps" role="list">
            {START_STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="cw-download-step-number" aria-hidden="true">{index + 1}</span>
                <div><h3>{step.title}</h3><p>{step.text}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <aside className="cw-download-scope" aria-label="Availability and membership notes">
          <p><strong>About the product tour.</strong> The tour uses scripted examples of the developing app. See the release notes for this alpha's included features and verification limits.</p>
          <p><strong>About computer use.</strong> Native computer-control verification remains incomplete. Remote computers are not available.</p>
          <p><strong>About models.</strong> OpenWork Models membership is optional. It does not grant early access to Open Coworker and is not required to download this alpha.</p>
        </aside>

        <section className="cw-download-more" aria-label="Source code and early-access questions">
          <div>
            <h2>Prefer to build it yourself?</h2>
            <p>Explore the source and development instructions.</p>
            <div className="cw-download-more-links">
              <a href={COWORKER.app} className="cw-download-text-link">Build from source <ArrowUpRight size={14} aria-hidden="true" /></a>
              <a href={NOTIFY.releases.href} className="cw-download-text-link">GitHub releases <ArrowUpRight size={14} aria-hidden="true" /></a>
            </div>
          </div>
          <div>
            <h2>Questions about early access?</h2>
            <p>Ask the team about testing Open Coworker.</p>
            <a href={NOTIFY.email.href} className="cw-download-text-link">Email the team <ArrowUpRight size={14} aria-hidden="true" /></a>
            <p className="cw-download-email-note">Opens your email app. {COWORKER.contactEmail}</p>
          </div>
        </section>
      </main>

      <footer className="cw-download-footer">
        <a href="/">Powered by OpenWork</a>
        <a href={COWORKER.path}>Explore Open Coworker <ArrowRight size={14} aria-hidden="true" /></a>
      </footer>
    </div>
  );
}
