"use client"

import { useEffect, useState, type ReactNode } from "react"
import { detectPlatform, type DetectedArch, type DetectedOS, type DetectedPlatform } from "./platform-detect"

export type DownloadCardInstallers = {
  macos: { appleSilicon: string; intel: string }
  windows: { x64: string; arm64: string }
  linux: { appImageX64: string; appImageArm64: string; tarX64: string; tarArm64: string }
}

export type DownloadPlatformOption = {
  href: string
  label: string
  arch?: DetectedArch
}

export type DownloadPlatformGroup = {
  os: DetectedOS
  title: string
  options: DownloadPlatformOption[]
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
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

function PlatformIcon({ os, className }: { os: DetectedOS; className?: string }) {
  if (os === "macos") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
        <path d="M16.7 12.9c0-2 1.6-3 1.7-3.1a3.7 3.7 0 0 0-2.9-1.6c-1.2-.1-2.4.7-3 .7-.6 0-1.5-.7-2.5-.7-1.3 0-2.6.8-3.3 2-1.4 2.5-.4 6.1 1 8.1.7 1 1.5 2.1 2.6 2 .9 0 1.4-.6 2.6-.6 1.2 0 1.6.6 2.6.6 1.1 0 1.8-1 2.5-2a8.8 8.8 0 0 0 1.1-2.3 3.5 3.5 0 0 1-2.4-3.1ZM14.7 7c.6-.8 1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3Z" />
      </svg>
    )
  }

  if (os === "windows") {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
        <path d="m3 5.2 7.4-1v7.1H3V5.2Zm8.4-1.1L21 2.8v8.5h-9.6V4.1ZM3 12.3h7.4v7.1l-7.4-1v-6.1Zm8.4 0H21v8.5l-9.6-1.3v-7.2Z" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M8.5 18.5c-1.4-1.7-2-3.7-1.5-5.8.3-1.4 1.3-2.5 2.7-3.1-.2-.6-.2-1.3-.1-2C9.8 5.5 10.7 4 12 4s2.2 1.5 2.4 3.6c.1.7.1 1.4-.1 2 1.4.6 2.4 1.7 2.7 3.1.5 2.1-.1 4.1-1.5 5.8" />
      <path d="M9 19c.8.7 1.8 1 3 1s2.2-.3 3-1M10.6 8.1h.1M13.3 8.1h.1M10.5 11.2c.9.7 2.1.7 3 0" />
    </svg>
  )
}

function DownloadColumn({
  os,
  title,
  detectedLabel,
  showPlatformIcon,
  children,
}: {
  os: DetectedOS
  title: string
  detectedLabel: string | null
  showPlatformIcon: boolean
  children: ReactNode
}) {
  return (
    <div className="bg-white px-6 py-4">
      <div className="flex items-center gap-2">
        {showPlatformIcon ? (
          <PlatformIcon os={os} className="h-4 w-4 text-[#07192C]" />
        ) : (
          <MonitorIcon className="h-4 w-4 text-[#8A96AC]" />
        )}
        <span className="text-[13px] font-semibold text-[#07192C]">{title}</span>
        {detectedLabel ? (
          <span className="rounded-full bg-[#E5F5EA] px-1.5 py-px text-[10px] font-medium text-[#15803D]">{detectedLabel}</span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-col gap-2">{children}</div>
    </div>
  )
}

function DownloadLink({
  href,
  children,
  recommended,
  testId,
  openInNewTab,
  keepLabelOnOneLine,
  onDownload,
}: {
  href: string
  children: ReactNode
  recommended?: boolean
  testId?: string
  openInNewTab: boolean
  keepLabelOnOneLine: boolean
  onDownload?: () => void
}) {
  return (
    <a
      href={href}
      target={openInNewTab ? "_blank" : undefined}
      rel={openInNewTab ? "noreferrer" : undefined}
      data-testid={testId ?? "download-openwork-link"}
      data-download-openwork-link="true"
      data-recommended={recommended ? "true" : undefined}
      onClick={onDownload}
      className={
        recommended
          ? `inline-flex items-center gap-2 rounded-lg border border-[#07192C] bg-[#07192C] px-3 py-2 text-[12px] font-medium text-white transition-colors hover:border-[#12283F] hover:bg-[#12283F]${keepLabelOnOneLine ? " whitespace-nowrap" : ""}`
          : `inline-flex items-center gap-2 rounded-lg border border-[#DFE5EE] bg-[#F8FAFC] px-3 py-2 text-[12px] font-medium text-[#1C2B44] transition-colors hover:border-[#C9D5E7] hover:bg-[#EEF4FC]${keepLabelOnOneLine ? " whitespace-nowrap" : ""}`
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

function isRecommended(detected: DetectedPlatform | null, os: DetectedOS, arch?: DetectedArch): boolean {
  return Boolean(arch && detected && detected.os === os && detected.arch === arch)
}

function useDetectedPlatform() {
  const [detected, setDetected] = useState<DetectedPlatform | null>(null)

  useEffect(() => {
    let cancelled = false
    void detectPlatform().then((platform) => {
      if (!cancelled) setDetected(platform)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return detected
}

function DownloadPlatformGridContent({
  detected,
  groups,
  openInNewTab,
  customCompanyPresentation,
  recommendedTestId,
  onDownload,
}: {
  detected: DetectedPlatform | null
  groups: DownloadPlatformGroup[]
  openInNewTab: boolean
  customCompanyPresentation: boolean
  recommendedTestId?: string
  onDownload?: (option: DownloadPlatformOption) => void
}) {
  return (
    <div className={`grid gap-px border-t border-[#E9EDF3] bg-[#E9EDF3] ${customCompanyPresentation ? "lg:grid-cols-3" : "sm:grid-cols-3"}`}>
      {groups.map((group) => (
        <DownloadColumn
          key={group.os}
          os={group.os}
          title={group.title}
          detectedLabel={getDetectedLabel(detected, group.os)}
          showPlatformIcon={customCompanyPresentation}
        >
          {group.options.map((option) => (
            <DownloadLink
              key={`${option.label}-${option.href}`}
              href={option.href}
              recommended={isRecommended(detected, group.os, option.arch)}
              testId={isRecommended(detected, group.os, option.arch) ? recommendedTestId : undefined}
              openInNewTab={openInNewTab}
              keepLabelOnOneLine={customCompanyPresentation}
              onDownload={onDownload ? () => onDownload(option) : undefined}
            >
              {option.label}
            </DownloadLink>
          ))}
        </DownloadColumn>
      ))}
    </div>
  )
}

export function DownloadPlatformGrid({
  groups,
  openInNewTab = false,
  recommendedTestId,
  onDownload,
}: {
  groups: DownloadPlatformGroup[]
  openInNewTab?: boolean
  recommendedTestId?: string
  onDownload?: (option: DownloadPlatformOption) => void
}) {
  const detected = useDetectedPlatform()

  return (
    <div
      data-testid="download-platform-grid"
      data-detected-os={detected?.os}
      data-detected-arch={detected ? detected.arch ?? "unknown" : undefined}
      data-detection-source={detected?.source}
      className="overflow-hidden rounded-[14px] border border-[#E3E7EE]"
    >
      <DownloadPlatformGridContent
        detected={detected}
        groups={groups}
        openInNewTab={openInNewTab}
        customCompanyPresentation
        recommendedTestId={recommendedTestId}
        onDownload={onDownload}
      />
    </div>
  )
}

function groupsForInstallers(installers: DownloadCardInstallers): DownloadPlatformGroup[] {
  return [
    {
      os: "macos",
      title: "macOS",
      options: [
        { href: installers.macos.appleSilicon, label: "Apple Silicon (M1+)", arch: "arm64" },
        { href: installers.macos.intel, label: "Intel", arch: "x64" },
      ],
    },
    {
      os: "windows",
      title: "Windows",
      options: [
        { href: installers.windows.x64, label: "x64 Installer", arch: "x64" },
        { href: installers.windows.arm64, label: "ARM64 Installer", arch: "arm64" },
      ],
    },
    {
      os: "linux",
      title: "Linux",
      options: [
        { href: installers.linux.appImageX64, label: "AppImage (x64)", arch: "x64" },
        { href: installers.linux.appImageArm64, label: "AppImage (ARM64)", arch: "arm64" },
        { href: installers.linux.tarX64, label: "tar.gz (x64)" },
        { href: installers.linux.tarArm64, label: "tar.gz (ARM64)" },
      ],
    },
  ]
}

export function DownloadOpenWorkCard({
  installers,
  releaseTag,
}: {
  installers?: DownloadCardInstallers | null
  releaseTag?: string
}) {
  const detected = useDetectedPlatform()
  const resolvedInstallers = installers ?? FALLBACK_INSTALLERS
  const tag = releaseTag?.trim()

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

      <DownloadPlatformGridContent
        detected={detected}
        groups={groupsForInstallers(resolvedInstallers)}
        openInNewTab
        customCompanyPresentation={false}
      />
    </section>
  )
}
