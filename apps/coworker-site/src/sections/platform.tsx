import { useState } from "react";
import { CoworkerMark } from "@/ui/brand";
import { FOOTER, GET_STARTED, PLATFORM, SITE, allClaims } from "~/content";
import { Container, Pill, Reveal, Section } from "~/ui/primitives";

export function Platform() {
  return (
    <Section id="platform" title={PLATFORM.title} lead={PLATFORM.lead}>
      <Reveal className="mt-10">
        <dl className="grid gap-x-10 gap-y-5 border-t border-line pt-8 sm:grid-cols-2 lg:grid-cols-3">
          {PLATFORM.items.map((item) => (
            <div key={item.name} className="min-w-0">
              <dt className="text-[13px] font-semibold text-snow">{item.name}</dt>
              <dd className="mt-1 text-[13.5px] leading-relaxed text-mist">{item.text}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 text-[13.5px] text-mist">
          OpenWork is the open-source platform underneath — local engine, native threads, connectors, and OpenWork Cloud.{" "}
          <a href={SITE.openwork} className="text-snow underline decoration-white/25 underline-offset-4 hover:decoration-white/60" rel="noreferrer">
            openworklabs.com
          </a>
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
    <Section id="get-started" title={GET_STARTED.title} lead={GET_STARTED.lead.text}>
      <Reveal className="mt-10">
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          <CommandBlock commands={GET_STARTED.commands} />
          <div className="flex flex-col gap-3 lg:pt-1">
            <Pill tone="amber">{GET_STARTED.status}</Pill>
            <p className="text-[13.5px] leading-relaxed text-mist">
              macOS first. The engine binary resolves from <span className="font-mono text-[12px] text-snow/90">OPENWORK_OPENCODE_BIN</span> or{" "}
              <span className="font-mono text-[12px] text-snow/90">opencode</span> on your PATH during development.
            </p>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

/** The trust mechanism, kept — but as a quiet disclosure rather than a caption under every card. */
function ClaimSources() {
  const claims = allClaims();
  return (
    <details className="group mt-10 border-t border-line pt-6">
      <summary className="cursor-pointer list-none text-[12.5px] font-medium text-mist transition-colors hover:text-snow">
        <span className="mr-2 inline-block transition-transform group-open:rotate-90" aria-hidden="true">›</span>
        {FOOTER.claimsTitle} <span className="text-mist/60">({claims.length})</span>
      </summary>
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {claims.map((claim) => (
          <li key={claim.source + claim.text.slice(0, 24)} className="min-w-0 text-[12px] leading-relaxed">
            <p className="text-mist">{claim.text}</p>
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-mist/60" title={claim.source}>
              {claim.source}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Footer() {
  return (
    <footer className="border-t hairline py-10">
      <Container>
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
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
        </div>
        <ClaimSources />
      </Container>
    </footer>
  );
}
