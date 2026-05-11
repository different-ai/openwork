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
            <span>Everything from OpenCode just works.</span>
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-4 md:gap-8">
          <Link href="/docs" className="transition-colors hover:text-gray-800">
            Docs
          </Link>
          <Link href="/download" className="transition-colors hover:text-gray-800">
            Download
          </Link>
          <Link href="/enterprise" className="transition-colors hover:text-gray-800">
            Enterprise
          </Link>
          <Link href="/den" className="transition-colors hover:text-gray-800">
            Den
          </Link>
          <div>© 2026 OpenWork Project.</div>
        </div>
      </div>
    </footer>
  );
}
