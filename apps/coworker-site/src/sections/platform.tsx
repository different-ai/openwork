import { useState } from "react";
import { CoworkerMark } from "@/ui/brand";
import { FOOTER, GET_STARTED, PLATFORM, SITE } from "~/content";
import { Container, Pill, Reveal, Section, SourceNote } from "~/ui/primitives";

export function Platform() {
  return (
    <Section id="platform" eyebrow="Powered by OpenWork" title={PLATFORM.title} lead={PLATFORM.lead}>
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLATFORM.items.map((item, index) => (
          <Reveal key={item.name} delay={(index % 3) * 70}>
            <div className="card h-full p-5">
              <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-snow">{item.name}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-mist">{item.text}</p>
              <SourceNote source={item.source} />
            </div>
          </Reveal>
        ))}
      </div>
      <Reveal>
        <p className="mt-8 max-w-2xl text-[13.5px] leading-relaxed text-mist">
          OpenWork is the open-source platform for AI work: local engine, native threads, connectors, and OpenWork Cloud. Learn more at{" "}
          <a href={SITE.openwork} className="text-snow underline decoration-white/25 underline-offset-4 hover:decoration-white/60" rel="noreferrer">
            openworklabs.com
          </a>
          .
        </p>
      </Reveal>
    </Section>
  );
}

function CommandBlock({ commands }: { commands: readonly string[] }) {
  const [copied, setCopied] = useState(false);
  const text = commands.join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the commands remain selectable text.
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] text-mist">Terminal</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-snow transition-colors hover:bg-white/[0.08]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.8] text-snow">
        {commands.map((command) => (
          <code key={command} className="block">
            <span className="select-none text-mist/60">$ </span>
            {command}
          </code>
        ))}
      </pre>
    </div>
  );
}

export function GetStarted() {
  return (
    <Section id="get-started" eyebrow="Get started" title={GET_STARTED.title} lead={GET_STARTED.lead}>
      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Reveal>
          <CommandBlock commands={GET_STARTED.commands} />
        </Reveal>
        <Reveal delay={100}>
          <div className="flex h-full flex-col gap-4">
            <div className="card p-5">
              <Pill tone="amber">{GET_STARTED.status}</Pill>
              <p className="mt-3 text-[13.5px] leading-relaxed text-mist">
                macOS is the first platform. Signed, notarized builds and an update channel are in preparation; this page will link them the day they
                exist, not before.
              </p>
            </div>
            {GET_STARTED.notes.map((note) => (
              <div key={note.source} className="card p-5">
                <p className="text-[13.5px] leading-relaxed text-snow/90">{note.text}</p>
                <SourceNote source={note.source} />
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

export function Footer() {
  return (
    <footer className="border-t hairline py-10">
      <Container className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <CoworkerMark size={28} label="Open Coworker" />
          <div>
            <p className="text-sm font-semibold text-snow">{SITE.name}</p>
            <p className="text-[12px] text-mist">
              © {SITE.year} {SITE.company} · {FOOTER.poweredBy}
            </p>
          </div>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-5">
          {FOOTER.links.map((link) => (
            <a key={link.href} href={link.href} rel="noreferrer" className="text-[13px] font-medium text-mist transition-colors hover:text-snow">
              {link.label}
            </a>
          ))}
        </nav>
      </Container>
    </footer>
  );
}
