"use client";

import Link from "next/link";
import { Download, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { OpenWorkMark } from "./openwork-mark";

type Props = {
  stars: string;
  callUrl?: string;
  downloadHref?: string;
  mobilePrimaryHref?: string;
  mobilePrimaryLabel?: string;
  active?: "home" | "pricing" | "download" | "enterprise" | "den" | "docs";
};

export function SiteNav(props: Props) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const callHref = props.callUrl || "/enterprise#book";
  const downloadHref = props.downloadHref || "/download";
  const downloadPageHref = "/download";
  const mobilePrimaryHref = props.mobilePrimaryHref || downloadHref;
  const mobilePrimaryLabel = props.mobilePrimaryLabel || "Desktop";
  const callExternal = /^https?:\/\//.test(callHref);
  const mobilePrimaryExternal = /^https?:\/\//.test(mobilePrimaryHref);
  const navItems = [
    { href: "/docs", label: "Docs", key: "docs" },
    { href: "/pricing", label: "Pricing", key: "pricing" },
    { href: "/download", label: "Desktop", key: "download" },
    { href: "https://app.openworklabs.com", label: "Cloud", key: "den" },
    { href: "/enterprise", label: "Enterprise", key: "enterprise" }
  ] as const;

  const navLink = (isActive: boolean) =>
    isActive
      ? "text-[#011627]"
      : "text-gray-600 transition-colors hover:text-[#011627]";

  return (
    <header className={`sticky top-0 z-20 w-full transition-all duration-300 ${scrolled ? "bg-white/80 shadow-sm backdrop-blur-md" : ""}`}>
      <div className="mx-auto flex max-w-5xl flex-col px-6 md:px-8">
        <div className="grid grid-cols-[auto_1fr_auto] items-center py-4">
          <Link
            href="/"
            className="group inline-flex items-center gap-1.5"
            onClick={() => setMobileOpen(false)}
          >
            <OpenWorkMark className="h-[30px] w-[38px] transition-opacity group-hover:opacity-80" />
            <span className="text-[1.2rem] font-semibold tracking-tight text-[#011627] md:text-[1.3rem]">
              OpenWork
            </span>
          </Link>

          <nav className="hidden items-center justify-center gap-8 text-[15px] font-medium md:flex">
            {navItems.map(item => (
              <Link
                key={item.key}
                href={item.href}
                {...(/^(?:https?:\/\/)/.test(item.href) ? { target: "_blank", rel: "noreferrer" } : {})}
                className={navLink(props.active === item.key)}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-4">
            <a
              href="https://github.com/different-ai/openwork"
              className="hidden items-center gap-2 rounded-full border border-gray-100 bg-white px-3.5 py-2 text-sm font-medium text-gray-500 shadow-[0_1px_2px_rgba(17,24,39,0.06)] transition-colors hover:text-[#011627] sm:flex"
              rel="noreferrer"
              target="_blank"
              aria-label="OpenWork GitHub stars"
            >
              <svg
                className="h-4 w-4"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.041-1.416-4.041-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              {props.stars}
            </a>
            <Link
              href={downloadPageHref}
              className="doc-button !hidden items-center gap-2 md:!inline-flex"
            >
              Desktop <Download size={16} />
            </Link>
            <button
              type="button"
              className="rounded-full p-2 text-[#011627] transition-colors hover:bg-white/70 md:hidden"
              onClick={() => setMobileOpen(current => !current)}
              aria-expanded={mobileOpen}
              aria-label={
                mobileOpen ? "Close navigation menu" : "Open navigation menu"
              }
            >
              {mobileOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>

        {mobileOpen ? (
          <div className="landing-shell mb-8 rounded-xl p-4 md:hidden">
            <div className="flex flex-col gap-1 text-[15px] font-medium text-gray-700">
              {navItems.map(item => (
                <Link
                  key={item.key}
                  href={item.href}
                  {...(/^(?:https?:\/\/)/.test(item.href) ? { target: "_blank", rel: "noreferrer" } : {})}
                  className={`rounded-2xl px-4 py-3 ${navLink(
                    props.active === item.key
                  )}`}
                  onClick={() => setMobileOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </div>

            <div className="mt-4 flex flex-col gap-3">
              <a
                href={mobilePrimaryHref}
                className="doc-button text-sm"
                rel={mobilePrimaryExternal ? "noreferrer" : undefined}
                target={mobilePrimaryExternal ? "_blank" : undefined}
              >
                {mobilePrimaryLabel}
              </a>
              <a
                href={callHref}
                className="secondary-button text-sm"
                rel={callExternal ? "noreferrer" : undefined}
                target={callExternal ? "_blank" : undefined}
              >
                Book a call
              </a>
              <a
                href="https://github.com/different-ai/openwork"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-100 bg-white px-4 py-2 text-sm font-medium text-gray-500 shadow-[0_1px_2px_rgba(17,24,39,0.06)] transition-colors hover:text-[#011627]"
                rel="noreferrer"
                target="_blank"
              >
                <svg
                  className="h-4 w-4"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.041-1.416-4.041-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                GitHub {props.stars}
              </a>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
