"use client"

import { useEffect, useState, type ReactNode } from "react"
import { detectPlatform, type DetectedArch, type DetectedOS, type DetectedPlatform } from "./platform-detect"

export type DownloadCardInstallers = {
  macos: { appleSilicon: string; intel: string }
  windows: { x64: string; arm64: string }
  linux: { appImageX64: string; appImageArm64: string; tarX64: string; tarArm64: string }
}

const FALLBACK_RELEASE = "https://github.com/different-ai/openwork/releases"

const FALLBACK_INSTALLERS: DownloadCardInstallers = {
  macos: { appleSilicon: FALLBACK_RELEASE, intel: FALLBACK_RELEASE },
  windows: { x64: FALLBACK_RELEASE, arm64: FALLBACK_RELEASE },
  linux: {
    appImageX64: FALLBACK_RELEASE,
    appImageArm64: FALLBACK_RELEASE,
    tarX64: FALLBACK_RELEASE,
    tarArm64: FALLBACK_RELEASE,
  },
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1={12} y1={15} x2={12} y2={3} />
    </svg>
  )
}

function MonitorIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x={2} y={3} width={20} height={14} rx={2} />
      <line x1={8} y1={21} x2={16} y2={21} />
      <line x1={12} y1={17} x2={12} y2={21} />
    </svg>
  )
}

function DownloadColumn({
  title,
  detectedLabel,
  children,
}: {
  title: string
  detectedLabel: string | null
  children: ReactNode
}) {
  return (
    <div className="bg-white px-6 py-4">
      <div className="flex items-center gap-2">
        <MonitorIcon className="h-4 w-4 text-[#8A96AC]" />
        <span className="text-[13px] font-semibold text-[#07192C]">{title}</span>
        {detectedLabel ? (
          <span className="rounded-full bg-[#E5F5EA] px-1.5 py-px text-[10px] font-medium text-[#15803D]">{detectedLabel}</span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-col gap-2">{children}</div>
    </div>
  )
}

function DownloadLink({ href, children, recommended }: { href: string; children: ReactNode; recommended?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid="download-openwork-link"
      data-recommended={recommended ? "true" : undefined}
      className={
        recommended
          ? "inline-flex items-center gap-2 rounded-lg border border-[#07192C] bg-[#07192C] px-3 py-2 text-[12px] font-medium text-white transition-colors hover:border-[#12283F] hover:bg-[#12283F]"
          : "inline-flex items-center gap-2 rounded-lg border border-[#DFE5EE] bg-[#F8FAFC] px-3 py-2 text-[12px] font-medium text-[#1C2B44] transition-colors hover:border-[#C9D5E7] hover:bg-[#EEF4FC]"
      }
    >
      <DownloadIcon className={`h-3 w-3 shrink-0 ${recommended ? "text-white/70" : "text-[#5A6886]"}`} />
      {children}
      {recommended ? (
        <span className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-white/15 px-1.5 py-px text-[10px] font-medium text-white/90">
          For your device
        </span>
      ) : null}
    </a>
  )
}

function getArchLabel(os: DetectedOS, arch: DetectedArch): string {
  if (os === "macos") return arch === "arm64" ? "Apple Silicon" : "Intel"
  return arch === "arm64" ? "ARM64" : "x64"
}

function getDetectedLabel(detected: DetectedPlatform | null, os: DetectedOS): string | null {
  if (!detected || detected.os !== os) return null
  if (detected.arch === null) return "Detected"
  return `Detected · ${getArchLabel(os, detected.arch)}`
}

function isRecommended(detected: DetectedPlatform | null, os: DetectedOS, arch: DetectedArch): boolean {
  return detected !== null && detected.os === os && detected.arch === arch
}

export function DownloadOpenWorkCard({
  installers,
  releaseTag,
}: {
  installers?: DownloadCardInstallers | null
  releaseTag?: string
}) {
  const [detected, setDetected] = useState<DetectedPlatform | null>(null)
  const resolvedInstallers = installers ?? FALLBACK_INSTALLERS
  const tag = releaseTag?.trim()

  useEffect(() => {
    let cancelled = false
    void detectPlatform().then((platform) => {
      if (!cancelled) setDetected(platform)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section
      data-testid="download-openwork-card"
      data-detected-os={detected?.os}
      data-detected-arch={detected ? detected.arch ?? "unknown" : undefined}
      data-detected-os-version={detected ? detected.osVersion ?? "unknown" : undefined}
      data-detection-source={detected?.source}
      className="overflow-hidden rounded-[18px] border border-[#E3E7EE] bg-white shadow-[0_24px_60px_-32px_rgba(7,25,44,0.22)]"
    >
      <div className="bg-gradient-to-b from-[#FAFBFE] to-white px-6 py-5">
        <div className="flex items-center gap-2.5">
          <DownloadIcon className="h-5 w-5 text-[#07192C]/70" />
          <span className="text-[16px] font-semibold text-[#07192C]">Download OpenWork</span>
          {tag ? (
            <span className="rounded-full bg-[#F1F4F9] px-2 py-0.5 text-[11px] font-medium text-[#5A6886]">{tag}</span>
          ) : null}
        </div>
        <p className="mt-2 max-w-[520px] text-[13px] leading-[1.6] text-[#5A6886]">
          Install the desktop app on macOS, Windows, or Linux. Your workspace connects automatically after sign-in.
        </p>
      </div>

      <div className="grid gap-px border-t border-[#E9EDF3] bg-[#E9EDF3] sm:grid-cols-3">
        <DownloadColumn title="macOS" detectedLabel={getDetectedLabel(detected, "macos")}>
          <DownloadLink href={resolvedInstallers.macos.appleSilicon} recommended={isRecommended(detected, "macos", "arm64")}>
            Apple Silicon (M1+)
          </DownloadLink>
          <DownloadLink href={resolvedInstallers.macos.intel} recommended={isRecommended(detected, "macos", "x64")}>
            Intel
          </DownloadLink>
        </DownloadColumn>

        <DownloadColumn title="Windows" detectedLabel={getDetectedLabel(detected, "windows")}>
          <DownloadLink href={resolvedInstallers.windows.x64} recommended={isRecommended(detected, "windows", "x64")}>
            x64 Installer
          </DownloadLink>
          <DownloadLink href={resolvedInstallers.windows.arm64} recommended={isRecommended(detected, "windows", "arm64")}>
            ARM64 Installer
          </DownloadLink>
        </DownloadColumn>

        <DownloadColumn title="Linux" detectedLabel={getDetectedLabel(detected, "linux")}>
          <DownloadLink href={resolvedInstallers.linux.appImageX64} recommended={isRecommended(detected, "linux", "x64")}>
            AppImage (x64)
          </DownloadLink>
          <DownloadLink href={resolvedInstallers.linux.appImageArm64} recommended={isRecommended(detected, "linux", "arm64")}>
            AppImage (ARM64)
          </DownloadLink>
          <DownloadLink href={resolvedInstallers.linux.tarX64}>tar.gz (x64)</DownloadLink>
          <DownloadLink href={resolvedInstallers.linux.tarArm64}>tar.gz (ARM64)</DownloadLink>
        </DownloadColumn>
      </div>
    </section>
  )
}
