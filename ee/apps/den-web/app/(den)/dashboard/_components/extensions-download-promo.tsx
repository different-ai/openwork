import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { getMarketplacesRoute } from "../../_lib/den-org";

export function ExtensionsDownloadPromo({ orgSlug }: { orgSlug: string }) {
  return (
    <section className="rounded-[18px] border border-[#d7e2f5] bg-gradient-to-br from-[#F4F8FF] to-[#EEF3FF] p-5">
      <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-[#07192C]">
        Download the app to unlock extensions
      </h2>
      <p className="mt-1.5 text-[13px] leading-6 text-[#526582]">
        Sign in with this account to get Computer Use, Browser, Image Gen, Google Workspace, and your team&apos;s marketplace extensions — all built in.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href={getMarketplacesRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#d8e0ec] bg-white px-3.5 py-1.5 text-[13px] font-semibold text-[#07192C] transition hover:bg-gray-50"
        >
          View all extensions <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}
