"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  Download,
  Gauge,
  Monitor,
  Users,
} from "lucide-react";
import Link from "next/link";
import { getMarketplacesRoute } from "../../_lib/den-org";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "../../_lib/den-flow";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/* ── Types ── */

type AdoptionData = {
  members: number;
  pendingInvites: number;
  activeUsers7d: number;
  activeUsers30d: number;
  weeklyTrend: number[];
};

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type Release = {
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  tag_name?: string;
  assets?: ReleaseAsset[];
};

type Installers = {
  macos: { appleSilicon: string; intel: string };
  windows: { x64: string };
  linux: { appImageX64: string; appImageArm64: string };
};

/* ── Data ── */

async function fetchAdoption(): Promise<AdoptionData | null> {
  try {
    const { response, payload } = await requestJson("/v1/telemetry/adoption", { method: "GET" }, 12000);
    if (!response.ok || !payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    return {
      members: typeof p.members === "number" ? p.members : 0,
      pendingInvites: typeof p.pendingInvites === "number" ? p.pendingInvites : 0,
      activeUsers7d: typeof p.activeMembers7d === "number" ? p.activeMembers7d : (typeof p.activeUsers7d === "number" ? p.activeUsers7d : 0),
      activeUsers30d: typeof p.activeMembers30d === "number" ? p.activeMembers30d : (typeof p.activeUsers30d === "number" ? p.activeUsers30d : 0),
      weeklyTrend: Array.isArray(p.weeklyTrend) ? p.weeklyTrend.map(Number) : [],
    };
  } catch {
    return null;
  }
}

const FALLBACK_RELEASE = "https://github.com/different-ai/openwork/releases";

function selectAsset(assets: ReleaseAsset[], extensions: string[], keywords: string[] = []): ReleaseAsset | null {
  const matches = assets.filter((asset) => {
    if (!asset?.name || !asset?.browser_download_url) return false;
    const name = asset.name.toLowerCase();
    const extOk = extensions.some((ext) => name.endsWith(ext));
    const kwOk = keywords.length === 0 || keywords.some((kw) => name.includes(kw));
    return extOk && kwOk;
  });
  if (matches.length === 0) return null;
  return (
    matches.find((a) => a.name?.toLowerCase().includes("adhoc")) ||
    matches.find((a) => a.name?.toLowerCase().includes("universal")) ||
    matches.find((a) => a.name?.toLowerCase().includes("aarch64")) ||
    matches.find((a) => a.name?.toLowerCase().includes("arm64")) ||
    matches[0]
  );
}

async function fetchInstallers(): Promise<{ installers: Installers; releaseTag: string; releaseUrl: string }> {
  const fallback: Installers = {
    macos: { appleSilicon: FALLBACK_RELEASE, intel: FALLBACK_RELEASE },
    windows: { x64: FALLBACK_RELEASE },
    linux: { appImageX64: FALLBACK_RELEASE, appImageArm64: FALLBACK_RELEASE },
  };
  try {
    const res = await fetch("https://api.github.com/repos/different-ai/openwork/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { installers: fallback, releaseTag: "", releaseUrl: FALLBACK_RELEASE };
    const release = (await res.json()) as Release;
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const releaseUrl = release?.html_url || FALLBACK_RELEASE;
    const releaseTag = release?.tag_name || "";

    const macApple = selectAsset(assets, [".dmg"], ["mac-arm64"]);
    const macIntel = selectAsset(assets, [".dmg"], ["mac-x64"]);
    const dmg = selectAsset(assets, [".dmg"], ["openwork-mac-"]);
    const winX64 = selectAsset(assets, [".exe"], ["win-x64"]);
    const linuxAppX64 = selectAsset(assets, [".appimage"], ["linux-x86_64"]) || selectAsset(assets, [".appimage"], ["linux-x64"]);
    const linuxAppArm64 = selectAsset(assets, [".appimage"], ["linux-arm64"]);

    return {
      installers: {
        macos: {
          appleSilicon: macApple?.browser_download_url || dmg?.browser_download_url || releaseUrl,
          intel: macIntel?.browser_download_url || dmg?.browser_download_url || releaseUrl,
        },
        windows: { x64: winX64?.browser_download_url || releaseUrl },
        linux: {
          appImageX64: linuxAppX64?.browser_download_url || releaseUrl,
          appImageArm64: linuxAppArm64?.browser_download_url || releaseUrl,
        },
      },
      releaseTag,
      releaseUrl,
    };
  } catch {
    return { installers: fallback, releaseTag: "", releaseUrl: FALLBACK_RELEASE };
  }
}

/* ── Helpers ── */

function getGreeting(name: string | null | undefined) {
  const hour = new Date().getHours();
  const g = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return `${g}, ${name?.trim().split(/\s+/)[0] ?? "there"}`;
}

function detectOS(): "macos" | "windows" | "linux" {
  if (typeof navigator === "undefined") return "macos";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "macos";
}

function toneBg(tone: "violet" | "green" | "blue") {
  switch (tone) {
    case "violet": return "bg-[#EDE4FF]";
    case "green": return "bg-[#E3F3E3]";
    case "blue": return "bg-[#E4ECFB]";
  }
}

/* ── Small components ── */

function StatCard({ icon, title, value, sub, tone }: {
  icon: React.ReactNode; title: string; value: string; sub?: string; tone: "violet" | "green" | "blue";
}) {
  return (
    <div className="rounded-[16px] border border-[#e3e7ee] bg-white/90 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] ${toneBg(tone)}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-[13px] font-medium tracking-[-0.01em] text-[#30405F]">{title}</div>
          <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.03em] text-[#07192C]">{value}</div>
          {sub ? <div className="mt-0.5 truncate text-[12px] text-[#637291]">{sub}</div> : null}
        </div>
      </div>
    </div>
  );
}

function DownloadLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-white/10"
    >
      <Download className="h-3 w-3 shrink-0" />
      {children}
    </a>
  );
}

/* ── Main screen ── */

export function DashboardOverviewScreen() {
  const { activeOrg, orgContext } = useOrgDashboard();
  const { user } = useDenFlow();
  const [os, setOs] = useState<"macos" | "windows" | "linux" | null>(null);

  useEffect(() => { setOs(detectOS()); }, []);

  const { data: adoption } = useQuery({
    queryKey: ["telemetry", "adoption"],
    queryFn: fetchAdoption,
  });

  const { data: releaseData } = useQuery({
    queryKey: ["github", "releases"],
    queryFn: fetchInstallers,
    staleTime: 1000 * 60 * 60,
  });

  const members = adoption?.members ?? orgContext?.members.length ?? 0;
  const pending = adoption?.pendingInvites ?? (orgContext?.invitations ?? []).filter((i) => i.status === "pending").length;
  const inst = releaseData?.installers;

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-8 pt-4 sm:px-6 md:px-8">

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[#e7e9f0] pb-3">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C]">{activeOrg?.name ?? "OpenWork Cloud"}</span>
        <ChevronRight className="h-3.5 w-3.5 text-[#9AA5BA]" />
        <span className="text-[14px] font-medium tracking-[-0.01em] text-[#5A6886]">Dashboard</span>
      </div>

      {/* Greeting */}
      <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.03em] text-[#07192C]">{getGreeting(user?.name)}</h1>
      <p className="mt-1 text-[14px] leading-6 text-[#5A6886]">
        Run locally for free. Keep data on your machine and move to shared workflows when ready.
      </p>

      {/* Extensions banner */}
      <section className="mt-5 rounded-[18px] border border-[#d7e2f5] bg-gradient-to-br from-[#F4F8FF] to-[#EEF3FF] p-5">
        <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-[#07192C]">Download the app to unlock extensions</h2>
        <p className="mt-1.5 text-[13px] leading-6 text-[#526582]">
          Sign in with this account to get Computer Use, Browser, Image Gen, Google Workspace, and your team&apos;s marketplace extensions — all built in.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={getMarketplacesRoute(activeOrg?.slug ?? "")} className="inline-flex items-center gap-1.5 rounded-full border border-[#d8e0ec] bg-white px-3.5 py-1.5 text-[13px] font-semibold text-[#07192C] transition hover:bg-gray-50">
            View all extensions <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>

      {/* Download OpenWork */}
      <section className="mt-4 overflow-hidden rounded-[18px] border border-[#e3e7ee] bg-[#07192C]">
        <div className="px-6 py-5">
          <div className="flex items-center gap-2.5">
            <Download className="h-5 w-5 text-white/80" />
            <span className="text-[16px] font-semibold text-white">Download OpenWork</span>
            {releaseData?.releaseTag ? (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/60">{releaseData.releaseTag}</span>
            ) : null}
          </div>
          <p className="mt-2 max-w-[520px] text-[13px] leading-[1.6] text-white/50">
            Install the desktop app on macOS, Windows, or Linux. Your workspace connects automatically after sign-in.
          </p>
        </div>

        <div className="grid gap-px bg-white/[0.06] sm:grid-cols-3">
          {/* macOS */}
          <div className="bg-[#07192C] px-6 py-4">
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-white/60" />
              <span className="text-[13px] font-semibold text-white">macOS</span>
              {os === "macos" ? <span className="rounded-full bg-[#18A34A]/20 px-1.5 py-px text-[10px] font-medium text-[#4ADE80]">Detected</span> : null}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <DownloadLink href={inst?.macos.appleSilicon ?? FALLBACK_RELEASE}>Apple Silicon (M1+)</DownloadLink>
              <DownloadLink href={inst?.macos.intel ?? FALLBACK_RELEASE}>Intel</DownloadLink>
            </div>
          </div>

          {/* Windows */}
          <div className="bg-[#07192C] px-6 py-4">
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-white/60" />
              <span className="text-[13px] font-semibold text-white">Windows</span>
              {os === "windows" ? <span className="rounded-full bg-[#18A34A]/20 px-1.5 py-px text-[10px] font-medium text-[#4ADE80]">Detected</span> : null}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <DownloadLink href={inst?.windows.x64 ?? FALLBACK_RELEASE}>x64 Installer</DownloadLink>
            </div>
          </div>

          {/* Linux */}
          <div className="bg-[#07192C] px-6 py-4">
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-white/60" />
              <span className="text-[13px] font-semibold text-white">Linux</span>
              {os === "linux" ? <span className="rounded-full bg-[#18A34A]/20 px-1.5 py-px text-[10px] font-medium text-[#4ADE80]">Detected</span> : null}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <DownloadLink href={inst?.linux.appImageX64 ?? FALLBACK_RELEASE}>AppImage (x64)</DownloadLink>
              <DownloadLink href={inst?.linux.appImageArm64 ?? FALLBACK_RELEASE}>AppImage (ARM64)</DownloadLink>
            </div>
          </div>
        </div>
      </section>

      {/* Live org data */}
      <div className="mt-5 grid gap-3.5 md:grid-cols-2">
        <StatCard icon={<Users className="h-5 w-5 text-[#6F3DFF]" />} title="OpenWork users" value={`${members}`} sub="Current workspace members" tone="violet" />
        <StatCard icon={<Gauge className="h-5 w-5 text-[#1D63FF]" />} title="Pending invites" value={`${pending}`} sub="Awaiting activation" tone="blue" />
      </div>
    </div>
  );
}
