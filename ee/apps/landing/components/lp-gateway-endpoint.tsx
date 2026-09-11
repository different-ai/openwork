"use client";

import { Check, Copy } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

import { BrandLogo } from "./lp-brand-logos";
import { OpenWorkMark } from "./openwork-mark";

type Props = {
  url: string;
};

const clients: { label: string; logo: "openwork" | "claude" | "cursor" | "codex" | "openai" }[] = [
  { label: "OpenWork", logo: "openwork" },
  { label: "Claude Code", logo: "claude" },
  { label: "Cursor", logo: "cursor" },
  { label: "Codex", logo: "codex" },
  { label: "ChatGPT", logo: "openai" }
];

const points = [
  {
    title: "Add once",
    body: "Connect a server or skill to your org. Every teammate and agent gets it instantly."
  },
  {
    title: "Sign in once",
    body: "Members authenticate with their OpenWork account. Credentials stay in the gateway."
  },
  {
    title: "Governed by default",
    body: "Roles and policies apply to every call, in every client. Nothing to configure per seat."
  }
];

function ClientGlyph({ logo }: { logo: (typeof clients)[number]["logo"] }) {
  if (logo === "openwork") {
    return <OpenWorkMark className="h-4 w-4 object-contain brightness-0 invert" />;
  }
  if (logo === "codex") {
    return (
      <Image
        src="/connect-icons/codex.png"
        width={16}
        height={16}
        alt=""
        className="h-4 w-4 rounded-[3px]"
      />
    );
  }
  return <BrandLogo name={logo} className="h-4 w-4" />;
}

export function LpGatewayEndpoint({ url }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div>
      <div className="rounded-[20px] bg-[var(--lp-terminal)] p-6 text-white md:p-8">
        <div className="flex items-center justify-between gap-4">
          <span className="mono text-[11px] tracking-[0.1em] text-white/50">
            GATEWAY ENDPOINT
          </span>
          <span className="mono hidden text-[11px] tracking-[0.06em] text-white/40 sm:inline">
            MCP · Streamable HTTP
          </span>
        </div>

        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <code className="mono break-all text-[17px] leading-[26px] text-white sm:whitespace-nowrap md:text-[22px]">
            {url}
          </code>
          <button
            type="button"
            onClick={() => {
              void copy();
            }}
            aria-label={`Copy ${url}`}
            className="inline-flex h-10 min-w-[104px] shrink-0 items-center justify-center gap-2 rounded-full bg-white px-4 text-[13px] font-medium text-[var(--lp-ink)] transition-opacity hover:opacity-90 active:scale-[0.97]"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                Copy
              </>
            )}
            <span className="sr-only" aria-live="polite">
              {copied ? "Copied" : ""}
            </span>
          </button>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-white/10 pt-5">
          <span className="mr-1 text-[13px] text-white/50">Works in</span>
          {clients.map((client) => (
            <span
              key={client.label}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-[13px] text-white/90"
            >
              <ClientGlyph logo={client.logo} />
              {client.label}
            </span>
          ))}
          <span className="inline-flex items-center rounded-full px-2 py-1.5 text-[13px] text-white/50">
            and any MCP client
          </span>
        </div>
      </div>

      <div className="mt-8 grid gap-6 border-t border-[var(--lp-border)] pt-6 md:grid-cols-3 md:gap-0">
        {points.map((point, index) => (
          <div
            key={point.title}
            className={
              index === 1
                ? "md:border-x md:border-[var(--lp-border)] md:px-6"
                : index === 0
                  ? "md:pr-6"
                  : "md:pl-6"
            }
          >
            <div className="text-[15px] font-medium text-[var(--lp-ink)]">{point.title}</div>
            <p className="mt-1.5 text-[14px] leading-[22px] text-[var(--lp-body)]">
              {point.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
