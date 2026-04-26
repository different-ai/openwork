import Link from "next/link";
import {
  AppWindow,
  ArrowUpRight,
  Cpu,
  Download as DownloadIcon,
  HardDrive,
  Lock,
  Package,
  Star,
  Terminal,
  Zap
} from "lucide-react";
import BubbleButton from "@/components/ui/bubble-button";
import DotsPattern from "@/components/ui/dots-pattern";
import Eyebrow from "@/components/ui/eyebrow";
import { StructuredData } from "@/components/structured-data";
import { GITHUB_URL } from "@/constants";
import GithubIcon from "@/icons/brands/github-icon";
import { getGithubData } from "@/lib/github";
import { baseOpenGraph } from "@/lib/seo";

const downloadSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenWork",
  description:
    "Open source Claude Cowork alternative. Desktop app for macOS, Windows, and Linux that lets teams use 50+ LLMs with their own provider keys.",
  url: "https://openworklabs.com/download",
  downloadUrl: "https://github.com/different-ai/openwork/releases/latest",
  applicationCategory: "BusinessApplication",
  operatingSystem: "macOS, Windows, Linux",
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

export const metadata = {
  title: "Download OpenWork — macOS, Windows, Linux",
  description:
    "Download OpenWork desktop for macOS, Windows, and Linux. Includes AUR install instructions and direct package downloads.",
  alternates: {
    canonical: "/download"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/download"
  }
};

const TermComment = ({ children }: { children: React.ReactNode }) => (
  <span className="term-muted">{children}</span>
);
const TermVal = ({ children }: { children: React.ReactNode }) => (
  <span className="term-val">{children}</span>
);
const TermPrompt = () => <span className="term-prompt">$</span>;

const HIGHLIGHTS = [
  { Icon: Lock, label: "Local-first", body: "Your machine, your keys, your audit log." },
  { Icon: Zap, label: "Free forever", body: "Open source under AGPL. No card required." },
  { Icon: Package, label: "Bring your own keys", body: "50+ providers via OpenCode config." }
];

export default async function Download() {
  const github = await getGithubData();
  const releaseLabel = github.releaseTag || "latest";
  const releaseUrl = github.releaseUrl;

  return (
    <div className="download-page relative min-h-screen pt-[6rem] md:pt-[8rem]">
      <StructuredData data={downloadSchema} />

      {/* ─────────────────────────── Hero ─────────────────────────── */}
      <section className="relative isolate overflow-hidden pb-(--sections-gap)">
        <DotsPattern className="opacity-50" />

        <div className="relative grid-12 items-center gap-y-[6.4rem] px-(--container-px)">
          <div className="col-span-12 flex flex-col gap-base-lg md:col-span-7">
            <Link
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="border-foreground/15 hover:border-primary/60 bg-background w-fit flex items-center gap-xs rounded-full border py-[0.35rem] pl-[0.35rem] pr-sm font-sans text-[1.05rem] font-medium text-foreground/70 transition-colors group"
            >
              <span className="bg-primary/12 grid size-[2rem] place-content-center rounded-full">
                <DownloadIcon className="size-[1rem] text-primary" />
              </span>
              <span className="font-sans text-foreground/90 font-bold uppercase tracking-[0.08em] text-[1rem] leading-none">
                Latest stable
              </span>
              <span className="bg-foreground/15 h-[1.1rem] w-px" />
              <span className="font-mono text-foreground/90 text-[1rem] font-semibold leading-none group-hover:text-primary transition-colors">
                {releaseLabel}
              </span>
              <ArrowUpRight className="size-[1.1rem] text-foreground/50 group-hover:text-primary transition-colors -ml-2xs" />
            </Link>

            <h1 className="text-[5.6rem] leading-[1.02] tracking-[-0.025em] sm:text-[6.4rem] md:text-[7.2rem]">
              <span className="font-sans font-bold">Download</span>{" "}
              <span className="font-serif font-light italic">OpenWork.</span>
              <br />
              <span className="font-sans font-bold">Run agents</span>{" "}
              <span className="font-serif font-light italic">on your machine.</span>
            </h1>

            <p className="font-sans text-[1.7rem] font-medium leading-[1.55] text-foreground/65 max-w-[52rem]">
              Open source desktop for agentic workflows. Install on macOS, Windows, or Linux —
              bring your own keys, drop in skills and MCP servers, and ship to your team without
              ever leaving your machine.
            </p>

            <div className="gap-sm flex flex-wrap items-center pt-sm">
              <BubbleButton isLink href="#macos">
                Pick your platform
              </BubbleButton>
              <BubbleButton isLink href={GITHUB_URL} target="_blank" variant="secondary">
                Star on GitHub
              </BubbleButton>
            </div>

            <ul className="gap-base-lg flex flex-wrap items-center pt-base text-foreground/60 font-sans text-[1.3rem] font-medium">
              {HIGHLIGHTS.map(({ Icon, label }) => (
                <li key={label} className="gap-xs flex items-center">
                  <span className="border-primary/40 grid size-[2.4rem] place-content-center rounded-full border border-dashed">
                    <Icon className="size-[1.2rem] text-primary" />
                  </span>
                  {label}
                </li>
              ))}
            </ul>
          </div>

          {/* Right — terminal-style preview */}
          <div className="col-span-12 md:col-span-5 md:pl-base-lg">
            <div className="relative">
              <div
                className="border-foreground/15 absolute -inset-base rounded-[1.6rem] border border-dashed pointer-events-none"
                aria-hidden
              />
              <div className="terminal-surface relative overflow-hidden rounded-[1.2rem] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.45)]">
                <div className="term-bar flex items-center gap-sm px-base py-sm">
                  <span className="size-[1rem] rounded-full bg-[#ef4444]" />
                  <span className="size-[1rem] rounded-full bg-[#eab308]" />
                  <span className="size-[1rem] rounded-full bg-[#22c55e]" />
                  <span className="mx-auto font-sans text-[1.2rem] font-medium">
                    install.sh · {releaseLabel}
                  </span>
                </div>
                <pre className="m-0 p-base-lg font-mono text-[1.3rem] leading-[1.7] overflow-x-auto whitespace-pre">
                  <TermComment># macOS — Apple Silicon</TermComment>
                  {"\n"}
                  <TermPrompt /> open OpenWork-darwin-aarch64.dmg
                  {"\n\n"}
                  <TermComment># Arch Linux (AUR)</TermComment>
                  {"\n"}
                  <TermPrompt /> yay -S openwork
                  {"\n\n"}
                  <TermComment># Windows — x64</TermComment>
                  {"\n"}
                  <TermPrompt /> msiexec /i OpenWork-windows-x64.msi
                  {"\n\n"}
                  <TermComment>→ ready in </TermComment>
                  <TermVal>under a minute</TermVal>
                  <TermComment>.</TermComment>
                </pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─────────────────────────── Platform picker ─────────────────────────── */}
      <section className="px-(--container-px) pb-(--sections-gap)">
        <div className="mx-auto max-w-[140rem]">
          <div className="grid-12 items-end gap-y-base-lg mb-[4.8rem]">
            <header className="col-span-12 md:col-span-7 flex flex-col gap-base">
              <Eyebrow>Pick your platform</Eyebrow>
              <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
                <span className="font-sans font-bold">Three platforms.</span>
                <br />
                <span className="font-serif font-light italic">One workspace.</span>
              </h2>
            </header>
            <p className="col-span-12 md:col-span-4 md:col-start-9 font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
              Native desktop builds for every major OS. Same engine, same skills, same
              permissions — wherever your team works.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-base sm:grid-cols-2 md:grid-cols-3">
            <PlatformPickerCard
              href="#macos"
              eyebrow="Apple"
              title="macOS"
              hook="The signature build."
              description="Universal DMGs for Apple Silicon and Intel."
              tags={["Apple Silicon", "Intel x64"]}
              featured
            />
            <PlatformPickerCard
              href="#windows"
              eyebrow="Microsoft"
              title="Windows"
              hook="One-click installer."
              description="Signed MSI installer for x64 systems."
              tags={["x64", ".msi"]}
            />
            <PlatformPickerCard
              href="#linux"
              eyebrow="Linux"
              title="Linux"
              hook="Pick your package manager."
              description="AUR, .deb, and .rpm packages for every distro."
              tags={["AUR", ".deb", ".rpm"]}
            />
          </div>
        </div>
      </section>

      {/* ─────────────────────────── macOS ─────────────────────────── */}
      <section
        id="macos"
        className="border-foreground/10 relative border-y bg-background-muted/40 py-(--sections-gap)"
      >
        <DotsPattern className="opacity-30" />

        <div className="relative px-(--container-px)">
          <div className="grid-12 mx-auto max-w-[140rem] items-end gap-y-base-lg mb-[6.4rem]">
            <header className="col-span-12 md:col-span-7 flex flex-col gap-base">
              <Eyebrow>macOS</Eyebrow>
              <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
                <span className="font-sans font-bold">For your</span>{" "}
                <span className="font-serif font-light italic">Mac.</span>
              </h2>
            </header>
            <p className="col-span-12 md:col-span-4 md:col-start-9 md:self-end font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
              Download the DMG that matches your chip. Works on macOS 12 (Monterey) and later.
            </p>
          </div>

          <div className="mx-auto grid max-w-[140rem] grid-cols-1 gap-base md:grid-cols-2">
            <PlatformDownloadCard
              num="01"
              chip="Recommended"
              title="Apple Silicon"
              hook="M-series Macs."
              description="For M1, M2, M3, and M4 chips. Native ARM build."
              ctaLabel="Download .dmg"
              href={github.installers.macos.appleSilicon}
              specs={[
                { Icon: Cpu, label: "Architecture", value: "arm64" },
                { Icon: Package, label: "Format", value: "Universal DMG" }
              ]}
              featured
            />
            <PlatformDownloadCard
              num="02"
              chip="Compatibility"
              title="Intel"
              hook="Intel-based Macs."
              description="For older Mac hardware running on Intel x64 chips."
              ctaLabel="Download .dmg"
              href={github.installers.macos.intel}
              specs={[
                { Icon: Cpu, label: "Architecture", value: "x64" },
                { Icon: Package, label: "Format", value: "Universal DMG" }
              ]}
            />
          </div>

          <p className="mx-auto mt-base-lg max-w-[140rem] text-center font-sans text-[1.3rem] font-medium text-foreground/50">
            macOS may ask you to allow the app on first launch — System Settings → Privacy &amp;
            Security.
          </p>
        </div>
      </section>

      {/* ─────────────────────────── Windows ─────────────────────────── */}
      <section id="windows" className="px-(--container-px) py-(--sections-gap)">
        <div className="mx-auto max-w-[140rem]">
          <div className="grid-12 items-end gap-y-base-lg mb-[6.4rem]">
            <header className="col-span-12 md:col-span-7 flex flex-col gap-base">
              <Eyebrow>Windows</Eyebrow>
              <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
                <span className="font-sans font-bold">For your</span>{" "}
                <span className="font-serif font-light italic">PC.</span>
              </h2>
            </header>
            <p className="col-span-12 md:col-span-4 md:col-start-9 md:self-end font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
              Signed MSI installer for x64 systems. Works on Windows 10 and Windows 11.
            </p>
          </div>

          <div className="grid-12 items-stretch gap-base">
            <article className="col-span-12 md:col-span-7 relative overflow-hidden rounded-sm border border-dashed border-foreground/15 bg-background-muted/40 p-(--container-px) flex flex-col gap-base-lg">
              <DotsPattern className="opacity-20" />
              <div className="relative flex flex-col gap-sm">
                <span className="font-serif italic font-light text-[6.4rem] leading-none text-primary/30">
                  01
                </span>
                <p className="font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em] text-primary">
                  Recommended · single binary
                </p>
                <h3 className="text-[3.2rem] leading-[1.1] tracking-[-0.02em]">
                  <span className="font-serif italic font-light">One installer.</span>{" "}
                  <span className="font-sans font-bold">Windows x64.</span>
                </h3>
                <p className="font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
                  Run the MSI to install OpenWork system-wide. Updates are signed and delivered
                  through the same channel.
                </p>
              </div>

              <ul className="relative flex flex-col">
                {[
                  { Icon: Cpu, label: "Architecture", value: "x64" },
                  { Icon: HardDrive, label: "Format", value: ".msi installer" },
                  { Icon: AppWindow, label: "Compatibility", value: "Windows 10, 11" }
                ].map(({ Icon, label, value }, i) => (
                  <li
                    key={label}
                    className={
                      "border-foreground/10 grid grid-cols-[auto_1fr_auto] items-center gap-base py-base " +
                      (i === 0 ? "" : "border-t border-dashed")
                    }
                  >
                    <span className="border-primary/40 grid size-[3.2rem] shrink-0 place-content-center rounded-full border border-dashed">
                      <Icon className="size-[1.4rem] text-primary" />
                    </span>
                    <span className="font-sans text-[1.4rem] font-medium leading-[1.5] text-foreground/65">
                      {label}
                    </span>
                    <span className="font-mono text-[1.3rem] text-foreground/80">{value}</span>
                  </li>
                ))}
              </ul>

              <div className="relative pt-base">
                <BubbleButton
                  isLink
                  href={github.installers.windows.x64}
                  target="_blank"
                >
                  Download .msi
                </BubbleButton>
              </div>
            </article>

            <article className="col-span-12 md:col-span-5 relative overflow-hidden rounded-sm">
              <div className="terminal-surface relative h-full overflow-hidden rounded-[1.2rem] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.45)]">
                <div className="term-bar flex items-center gap-sm px-base py-sm">
                  <span className="size-[1rem] rounded-full bg-[#ef4444]" />
                  <span className="size-[1rem] rounded-full bg-[#eab308]" />
                  <span className="size-[1rem] rounded-full bg-[#22c55e]" />
                  <span className="mx-auto font-sans text-[1.2rem] font-medium">
                    powershell.exe
                  </span>
                </div>
                <pre className="m-0 p-base-lg font-mono text-[1.3rem] leading-[1.7] overflow-x-auto whitespace-pre">
                  <TermComment># silent install</TermComment>
                  {"\n"}
                  <TermPrompt /> msiexec /i OpenWork.msi /qn
                  {"\n\n"}
                  <TermComment># or via winget</TermComment>
                  {"\n"}
                  <TermPrompt /> winget install OpenWork
                  {"\n\n"}
                  <TermComment># launch from anywhere</TermComment>
                  {"\n"}
                  <TermPrompt /> openwork start
                  {"\n"}
                  <TermComment>→ opencode server up on </TermComment>
                  <TermVal>:4096</TermVal>
                  {"\n"}
                  <TermComment>→ ready.</TermComment>
                </pre>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* ─────────────────────────── Linux ─────────────────────────── */}
      <section
        id="linux"
        className="border-foreground/10 relative border-y bg-background-muted/40 py-(--sections-gap)"
      >
        <DotsPattern className="opacity-30" />

        <div className="relative px-(--container-px)">
          <div className="grid-12 mx-auto max-w-[140rem] items-end gap-y-base-lg mb-[6.4rem]">
            <header className="col-span-12 md:col-span-7 flex flex-col gap-base">
              <Eyebrow>Linux</Eyebrow>
              <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
                <span className="font-sans font-bold">For your</span>{" "}
                <span className="font-serif font-light italic">distro.</span>
              </h2>
            </header>
            <p className="col-span-12 md:col-span-4 md:col-start-9 md:self-end font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
              Install through the AUR, or grab a package directly for Ubuntu, Debian, Fedora,
              RHEL, and openSUSE.
            </p>
          </div>

          <div className="mx-auto grid max-w-[140rem] grid-cols-1 gap-base md:grid-cols-12 md:grid-rows-2">
            {/* Featured tile — AUR (terminal surface) */}
            <article className="terminal-surface md:col-span-6 md:row-span-2 relative isolate overflow-hidden rounded-sm p-[3.2rem] flex flex-col justify-between min-h-[36rem]">
              <DotsPattern colorVariable="--t-fg" className="opacity-[0.08]" />

              <div className="relative flex flex-col gap-base">
                <span className="font-sans text-[1.1rem] font-bold uppercase tracking-[0.12em] text-secondary">
                  Recommended · auto-updates
                </span>
                <div className="term-border grid size-[6.4rem] place-content-center rounded-full border border-dashed">
                  <Terminal className="size-[3.2rem]" />
                </div>
                <h3 className="text-[3.6rem] leading-[1.05] tracking-[-0.02em]">
                  <span className="font-sans font-bold">Arch Linux.</span>{" "}
                  <span className="font-serif font-light italic term-muted">
                    The one-liner.
                  </span>
                </h3>
                <p className="font-sans text-[1.5rem] font-medium leading-[1.55] term-muted">
                  Install and keep OpenWork updated through the Arch User Repository. Works on
                  Manjaro, EndeavourOS, and any Arch-based distro.
                </p>
              </div>

              <div className="relative flex flex-col gap-base pt-base-lg">
                <pre className="term-border m-0 overflow-x-auto rounded-sm border border-dashed bg-white/5 p-base font-mono text-[1.4rem]">
                  <TermPrompt /> yay -S openwork
                </pre>
                <p className="font-sans text-[1.2rem] font-medium term-faint">
                  Prefer paru?{" "}
                  <code className="font-mono text-[0.95em]">paru -S openwork</code>
                </p>

                <a
                  href={github.installers.linux.aur}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-xs font-sans text-[1.3rem] font-bold uppercase tracking-[0.08em] text-secondary hover:text-white transition-colors"
                >
                  View package on AUR
                  <ArrowUpRight className="size-[1.4rem]" />
                </a>
              </div>
            </article>

            {/* .deb */}
            <article className="md:col-span-6 relative isolate overflow-hidden rounded-sm bg-background border border-dashed border-foreground/15 p-(--container-px) flex flex-col gap-base min-h-[18rem]">
              <div className="flex items-center gap-base">
                <div className="border-primary/40 grid size-[4.4rem] place-content-center rounded-full border border-dashed">
                  <Package className="size-[2rem] text-primary" />
                </div>
                <div className="flex flex-col">
                  <span className="font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em] text-primary">
                    Debian family
                  </span>
                  <h3 className="font-sans text-[2.2rem] font-bold tracking-[-0.02em]">
                    Ubuntu / Debian
                  </h3>
                </div>
              </div>
              <p className="font-sans text-[1.4rem] font-medium leading-[1.5] text-foreground/65">
                Download the .deb package for your architecture, then install with{" "}
                <code className="font-mono text-[0.95em] bg-background-muted px-xs py-2xs rounded">
                  sudo dpkg -i
                </code>
                .
              </p>
              <div className="flex flex-wrap gap-sm pt-xs">
                <a
                  href={github.installers.linux.debX64}
                  target="_blank"
                  rel="noreferrer"
                  className="border-foreground/20 hover:border-primary/40 hover:text-primary inline-flex items-center gap-xs rounded-full border border-dashed px-base py-sm font-mono text-[1.3rem] font-medium text-foreground transition-colors"
                >
                  <DownloadIcon className="size-[1.4rem]" />
                  x64 .deb
                </a>
                <a
                  href={github.installers.linux.debArm64}
                  target="_blank"
                  rel="noreferrer"
                  className="border-foreground/20 hover:border-primary/40 hover:text-primary inline-flex items-center gap-xs rounded-full border border-dashed px-base py-sm font-mono text-[1.3rem] font-medium text-foreground transition-colors"
                >
                  <DownloadIcon className="size-[1.4rem]" />
                  arm64 .deb
                </a>
              </div>
            </article>

            {/* .rpm */}
            <article className="md:col-span-6 relative isolate overflow-hidden rounded-sm bg-background border border-dashed border-foreground/15 p-(--container-px) flex flex-col gap-base min-h-[18rem]">
              <div className="flex items-center gap-base">
                <div className="border-primary/40 grid size-[4.4rem] place-content-center rounded-full border border-dashed">
                  <Package className="size-[2rem] text-primary" />
                </div>
                <div className="flex flex-col">
                  <span className="font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em] text-primary">
                    Red Hat family
                  </span>
                  <h3 className="font-sans text-[2.2rem] font-bold tracking-[-0.02em]">
                    Fedora / RHEL / openSUSE
                  </h3>
                </div>
              </div>
              <p className="font-sans text-[1.4rem] font-medium leading-[1.5] text-foreground/65">
                Pick the .rpm for your architecture, then install with{" "}
                <code className="font-mono text-[0.95em] bg-background-muted px-xs py-2xs rounded">
                  sudo rpm -i
                </code>{" "}
                or{" "}
                <code className="font-mono text-[0.95em] bg-background-muted px-xs py-2xs rounded">
                  dnf install
                </code>
                .
              </p>
              <div className="flex flex-wrap gap-sm pt-xs">
                <a
                  href={github.installers.linux.rpmX64}
                  target="_blank"
                  rel="noreferrer"
                  className="border-foreground/20 hover:border-primary/40 hover:text-primary inline-flex items-center gap-xs rounded-full border border-dashed px-base py-sm font-mono text-[1.3rem] font-medium text-foreground transition-colors"
                >
                  <DownloadIcon className="size-[1.4rem]" />
                  x64 .rpm
                </a>
                <a
                  href={github.installers.linux.rpmArm64}
                  target="_blank"
                  rel="noreferrer"
                  className="border-foreground/20 hover:border-primary/40 hover:text-primary inline-flex items-center gap-xs rounded-full border border-dashed px-base py-sm font-mono text-[1.3rem] font-medium text-foreground transition-colors"
                >
                  <DownloadIcon className="size-[1.4rem]" />
                  arm64 .rpm
                </a>
              </div>
            </article>
          </div>

          <p className="mx-auto mt-base-lg max-w-[140rem] text-center font-sans text-[1.3rem] font-medium text-foreground/50">
            Need another format — AppImage, tarball, source build?{" "}
            <a
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="text-foreground font-bold underline decoration-foreground/40 underline-offset-4 transition hover:decoration-foreground/70"
            >
              Browse all release assets
            </a>
            .
          </p>
        </div>
      </section>

      {/* ─────────────────────────── Next steps ─────────────────────────── */}
      <section className="px-(--container-px) py-(--sections-gap)">
        <div className="mx-auto max-w-[140rem]">
          <div className="grid-12 items-end gap-y-base-lg mb-[4.8rem]">
            <header className="col-span-12 md:col-span-7 flex flex-col gap-base">
              <Eyebrow>What&apos;s next</Eyebrow>
              <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
                <span className="font-serif font-light italic">Installed?</span>{" "}
                <span className="font-sans font-bold">Run your first agent.</span>
              </h2>
            </header>
            <p className="col-span-12 md:col-span-4 md:col-start-9 font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
              Three steps from a fresh install to a working agent on your folder. Same flow on
              every platform.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-base sm:grid-cols-2 md:grid-cols-3">
            <NextStepCard
              num="I"
              title="Authorize a folder"
              body="OpenWork only touches folders you explicitly allow. Approval is folder-scoped and revocable."
            />
            <NextStepCard
              num="II"
              title="Drop in a skill"
              body="Any standard OpenCode skill works — clone into .opencode/skills/ and reload."
            />
            <NextStepCard
              num="III"
              title="Pick your model"
              body="Bring your own keys for Anthropic, OpenAI, Gemini, Mistral, Groq, or local Ollama."
            />
          </div>
        </div>
      </section>

      {/* ─────────────────────────── Final CTA ─────────────────────────── */}
      <section className="px-(--container-px) pb-(--sections-gap)">
        <div className="terminal-surface relative mx-auto max-w-[140rem] overflow-hidden rounded-sm border border-dashed term-border">
          <DotsPattern colorVariable="--t-fg" className="opacity-[0.08]" />

          <div className="relative grid-12 items-center gap-y-[4.8rem] px-(--container-px) py-[6.4rem] md:py-[10rem]">
            <div className="col-span-12 md:col-span-7 flex flex-col gap-base-lg">
              <span className="term-border term-muted w-fit rounded-full border border-dashed px-base py-xs font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em]">
                Open source · AGPL
              </span>
              <h2 className="text-[4.4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.6rem] md:text-[6.4rem]">
                <span className="font-sans font-bold">Read the source</span>{" "}
                <span className="font-serif font-light italic">before you trust the binary.</span>
              </h2>
              <p className="font-sans text-[1.6rem] font-medium leading-[1.55] term-muted max-w-[48rem]">
                Every release is built from the public repo. Star it, fork it, audit it, ship it
                yourself. No telemetry you can&apos;t turn off, no provider you can&apos;t swap.
              </p>
              <div className="gap-sm flex flex-wrap items-center pt-sm">
                <BubbleButton
                  isLink
                  href={GITHUB_URL}
                  target="_blank"
                  variant="tertiary"
                >
                  Star on GitHub
                </BubbleButton>
                <BubbleButton isLink href={releaseUrl} target="_blank" variant="secondary">
                  All release assets
                </BubbleButton>
              </div>
            </div>

            <div className="col-span-12 md:col-span-4 md:col-start-9">
              <div className="term-border rounded-sm border border-dashed bg-white/5 p-(--container-px)">
                <div className="flex items-center gap-base mb-base-lg">
                  <span className="border-primary/40 bg-primary/15 grid size-[4rem] place-content-center rounded-full border border-dashed">
                    <GithubIcon className="size-[2rem]" />
                  </span>
                  <div className="flex flex-col">
                    <span className="font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em] term-faint">
                      different-ai/openwork
                    </span>
                    <span className="font-mono text-[1.3rem] font-bold">
                      {github.stars} stars
                    </span>
                  </div>
                </div>
                <ul className="grid grid-cols-2 gap-base">
                  <li className="flex flex-col gap-2xs">
                    <span className="font-serif italic font-light text-[3.6rem] leading-none text-secondary">
                      <Star className="inline size-[3rem] fill-secondary stroke-0" />
                    </span>
                    <span className="font-sans text-[1.2rem] font-medium uppercase tracking-[0.08em] term-faint">
                      Public repo
                    </span>
                  </li>
                  <li className="flex flex-col gap-2xs">
                    <span className="font-serif italic font-light text-[3.6rem] leading-none text-secondary">
                      AGPL
                    </span>
                    <span className="font-sans text-[1.2rem] font-medium uppercase tracking-[0.08em] term-faint">
                      Open license
                    </span>
                  </li>
                  <li className="flex flex-col gap-2xs">
                    <span className="font-serif italic font-light text-[3.6rem] leading-none text-secondary">
                      0
                    </span>
                    <span className="font-sans text-[1.2rem] font-medium uppercase tracking-[0.08em] term-faint">
                      Per-seat fees
                    </span>
                  </li>
                  <li className="flex flex-col gap-2xs">
                    <span className="font-serif italic font-light text-[3.6rem] leading-none text-secondary">
                      20+
                    </span>
                    <span className="font-sans text-[1.2rem] font-medium uppercase tracking-[0.08em] term-faint">
                      Releases / mo
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function PlatformPickerCard({
  href,
  eyebrow,
  title,
  hook,
  description,
  tags,
  featured = false
}: {
  href: string;
  eyebrow: string;
  title: string;
  hook: string;
  description: string;
  tags: string[];
  featured?: boolean;
}) {
  return (
    <a
      href={href}
      className={
        "group relative isolate overflow-hidden rounded-sm border border-dashed p-base-lg flex flex-col gap-base min-h-[24rem] transition-colors " +
        (featured
          ? "border-primary/40 bg-primary/5 hover:border-primary/70"
          : "border-foreground/15 bg-background-muted/40 hover:border-foreground/30")
      }
    >
      {featured ? <DotsPattern colorVariable="--primary" className="opacity-30" /> : null}
      <div className="relative flex items-center justify-between">
        <span
          className={
            "font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em] " +
            (featured ? "text-primary" : "text-foreground/40")
          }
        >
          {eyebrow}
        </span>
        <ArrowUpRight
          className={
            "size-[2rem] transition-transform group-hover:translate-x-[2px] group-hover:-translate-y-[2px] " +
            (featured ? "text-primary" : "text-foreground/50")
          }
        />
      </div>

      <div className="relative flex flex-col gap-sm">
        <h3 className="text-[3.2rem] leading-[1.05] tracking-[-0.02em]">
          <span className="font-sans font-bold">{title}</span>
        </h3>
        <p className="font-serif text-[1.8rem] font-light italic leading-[1.3] text-foreground/70">
          {hook}
        </p>
        <p className="font-sans text-[1.4rem] font-medium leading-[1.5] text-foreground/65">
          {description}
        </p>
      </div>

      <ul className="relative mt-auto flex flex-wrap gap-xs pt-base">
        {tags.map((tag) => (
          <li
            key={tag}
            className={
              "inline-flex items-center rounded-full border border-dashed px-base py-2xs font-mono text-[1.1rem] font-medium " +
              (featured
                ? "border-primary/40 text-primary"
                : "border-foreground/20 text-foreground/70")
            }
          >
            {tag}
          </li>
        ))}
      </ul>
    </a>
  );
}

function PlatformDownloadCard({
  num,
  chip,
  title,
  hook,
  description,
  ctaLabel,
  href,
  specs,
  featured = false
}: {
  num: string;
  chip: string;
  title: string;
  hook: string;
  description: string;
  ctaLabel: string;
  href: string;
  specs: { Icon: React.ComponentType<{ className?: string }>; label: string; value: string }[];
  featured?: boolean;
}) {
  return (
    <article
      className={
        "relative overflow-hidden rounded-sm border border-dashed p-(--container-px) flex flex-col gap-base-lg " +
        (featured
          ? "border-primary/40 bg-primary/5"
          : "border-foreground/15 bg-background")
      }
    >
      {featured ? <DotsPattern colorVariable="--primary" className="opacity-25" /> : null}
      <div className="relative flex items-start justify-between gap-base">
        <span className="font-serif italic font-light text-[6.4rem] leading-none text-primary/30">
          {num}
        </span>
        <span
          className={
            "rounded-full border border-dashed px-base py-xs font-sans text-[1.1rem] font-bold uppercase tracking-[0.08em] " +
            (featured
              ? "border-primary/60 bg-background text-primary"
              : "border-foreground/20 text-foreground/60")
          }
        >
          {chip}
        </span>
      </div>

      <div className="relative flex flex-col gap-sm">
        <h3 className="text-[3.2rem] leading-[1.1] tracking-[-0.02em]">
          <span className="font-serif italic font-light">{hook}</span>{" "}
          <span className="font-sans font-bold">{title}.</span>
        </h3>
        <p className="font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
          {description}
        </p>
      </div>

      <ul className="relative flex flex-col">
        {specs.map(({ Icon, label, value }, i) => (
          <li
            key={label}
            className={
              "border-foreground/10 grid grid-cols-[auto_1fr_auto] items-center gap-base py-base " +
              (i === 0 ? "" : "border-t border-dashed")
            }
          >
            <span className="border-primary/40 grid size-[3.2rem] shrink-0 place-content-center rounded-full border border-dashed">
              <Icon className="size-[1.4rem] text-primary" />
            </span>
            <span className="font-sans text-[1.4rem] font-medium leading-[1.5] text-foreground/65">
              {label}
            </span>
            <span className="font-mono text-[1.3rem] text-foreground/80">{value}</span>
          </li>
        ))}
      </ul>

      <div className="relative pt-xs">
        <BubbleButton isLink href={href} target="_blank" variant={featured ? "primary" : "secondary"}>
          {ctaLabel}
        </BubbleButton>
      </div>
    </article>
  );
}

function NextStepCard({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <article className="border-foreground/15 bg-background-muted/40 relative overflow-hidden rounded-sm border border-dashed flex flex-col p-base-lg gap-sm min-h-[22rem]">
      <span className="font-serif italic font-light text-[5.6rem] leading-none text-primary/40">
        {num}
      </span>
      <h3 className="text-[2.4rem] leading-[1.1] tracking-[-0.02em]">
        <span className="font-sans font-bold">{title}</span>
      </h3>
      <p className="font-sans text-[1.4rem] font-medium leading-[1.5] text-foreground/65">
        {body}
      </p>
    </article>
  );
}
