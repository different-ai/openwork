import Link from "next/link";

type Props = {
  stars: string;
  callUrl?: string;
  active?: "home" | "download" | "enterprise" | "den";
};

export function SiteNav(props: Props) {
  const call = "/enterprise#book";
  const navLink = (isActive: boolean) =>
    isActive ? "transition text-black" : "transition hover:text-black";
  return (
    <nav className="sticky top-0 z-50 py-4">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="inline-flex items-center gap-2 text-lg font-bold tracking-tight">
            <img
              src="/openwork-logo.svg"
              alt="OpenWork"
              className="h-7 w-7 rounded-sm"
            />
            <span>OpenWork</span>
          </Link>
          <div className="hidden items-center gap-6 text-[15px] text-gray-700 md:flex">
            <Link href="/#install" className="transition hover:text-black">
              Getting started
            </Link>
            <Link href="/#capabilities" className="transition hover:text-black">
              Features
            </Link>
            <Link href="/#faq" className="transition hover:text-black">
              FAQ
            </Link>
            <Link href="/docs" className="transition hover:text-black">
              Docs
            </Link>
            <Link href="/download" className={navLink(props.active === "download")}>
              Download
            </Link>
            <Link href="/enterprise" className={navLink(props.active === "enterprise")}>
              Enterprise
            </Link>
            <Link href="/den" className={navLink(props.active === "den")}>
              Den
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[14px]">
          <a
            href={call}
            className="hidden rounded-md bg-black px-3 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 sm:inline-flex"
          >
            Book a call
          </a>
          <a
            href="https://github.com/different-ai/openwork"
            className="flex items-center gap-1 text-gray-700 transition hover:text-black"
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
        </div>
      </div>
    </nav>
  );
}
