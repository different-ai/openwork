import Link from "next/link";
import { OpenCodeLogo } from "./opencode-logo";

export function SiteFooter() {
  return (
    <footer className="pt-10 text-sm text-gray-500">
      <div className="flex flex-col items-start justify-between gap-6 border-t border-gray-200 pt-10 md:flex-row md:items-center">
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

        <div className="flex flex-wrap items-center gap-4 md:gap-8">
          <Link href="/docs" target="_blank" className="transition-colors hover:text-gray-800">
            Docs
          </Link>
          <Link href="/pricing" className="transition-colors hover:text-gray-800">
            Pricing
          </Link>
          <Link href="/download" className="transition-colors hover:text-gray-800">
            Desktop
          </Link>
          <Link href="/den" className="transition-colors hover:text-gray-800">
            Cloud
          </Link>
          <Link href="/enterprise" className="transition-colors hover:text-gray-800">
            Enterprise
          </Link>
          <Link href="/trust" className="transition-colors hover:text-gray-800">
            Trust Center
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-gray-800">
            Privacy
          </Link>
          <Link href="/terms" className="transition-colors hover:text-gray-800">
            Terms
          </Link>
          <div>© 2026 Different AI</div>
        </div>
      </div>
    </footer>
  );
}
