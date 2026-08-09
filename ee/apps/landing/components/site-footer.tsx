import Link from "next/link";
import { OpenCodeLogo } from "./opencode-logo";

export function SiteFooter() {
  return (
    <footer className="pt-10 text-sm text-gray-500">
      <div className="flex flex-col items-start justify-between gap-6 border-t border-[var(--lp-border)] pt-10 md:flex-row md:items-center">
        <div className="flex flex-col gap-2">
          <div className="font-medium text-gray-800">Powered by</div>
          <a
            href="https://opencode.ai"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-3 text-gray-500 transition-colors hover:text-gray-800"
          >
            <OpenCodeLogo className="h-3 w-auto" />
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 md:gap-x-8">
          <Link href="/docs" target="_blank" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Docs
          </Link>
          <Link href="/pricing" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Pricing
          </Link>
          <Link href="/roadmap" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Roadmap
          </Link>
          <Link href="/download" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Desktop
          </Link>
          <a
            href="https://app.openworklabs.com"
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap transition-colors hover:text-gray-800"
          >
            Cloud
          </a>
          <Link href="/enterprise" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Enterprise
          </Link>
          <Link href="/contact" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Contact
          </Link>
          <Link href="/trust" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Trust Center
          </Link>
          <Link href="/privacy" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Privacy
          </Link>
          <Link href="/terms" className="whitespace-nowrap transition-colors hover:text-gray-800">
            Terms
          </Link>
          <div className="whitespace-nowrap">© 2026 Different AI</div>
        </div>
      </div>
    </footer>
  );
}
