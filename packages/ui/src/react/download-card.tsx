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

  // Tux from Font Awesome Free 6 brands (CC BY 4.0, fontawesome.com/license/free).
  return (
    <svg viewBox="0 0 448 512" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M220.8 123.3c1 .5 1.8 1.7 3 1.7 1.1 0 2.8-.4 2.9-1.5.2-1.4-1.9-2.3-3.2-2.9-1.7-.7-3.9-1-5.5-.1-.4.2-.8.7-.6 1.1.3 1.3 2.3 1.1 3.4 1.7zm-21.9 1.7c1.2 0 2-1.2 3-1.7 1.1-.6 3.1-.4 3.5-1.6.2-.4-.2-.9-.6-1.1-1.6-.9-3.8-.6-5.5.1-1.3.6-3.4 1.5-3.2 2.9.1 1 1.8 1.5 2.8 1.4zM420 403.8c-3.6-4-5.3-11.6-7.2-19.7-1.8-8.1-3.9-16.8-10.5-22.4-1.3-1.1-2.6-2.1-4-2.9-1.3-.8-2.7-1.5-4.1-2 9.2-27.3 5.6-54.5-3.7-79.1-11.4-30.1-31.3-56.4-46.5-74.4-17.1-21.5-33.7-41.9-33.4-72C311.1 85.4 315.7.1 234.8 0 132.4-.2 158 103.4 156.9 135.2c-1.7 23.4-6.4 41.8-22.5 64.7-18.9 22.5-45.5 58.8-58.1 96.7-6 17.9-8.8 36.1-6.2 53.3-6.5 5.8-11.4 14.7-16.6 20.2-4.2 4.3-10.3 5.9-17 8.3s-14 6-18.5 14.5c-2.1 3.9-2.8 8.1-2.8 12.4 0 3.9.6 7.9 1.2 11.8 1.2 8.1 2.5 15.7.8 20.8-5.2 14.4-5.9 24.4-2.2 31.7 3.8 7.3 11.4 10.5 20.1 12.3 17.3 3.6 40.8 2.7 59.3 12.5 19.8 10.4 39.9 14.1 55.9 10.4 11.6-2.6 21.1-9.6 25.9-20.2 12.5-.1 26.3-5.4 48.3-6.6 14.9-1.2 33.6 5.3 55.1 4.1.6 2.3 1.4 4.6 2.5 6.7v.1c8.3 16.7 23.8 24.3 40.3 23 16.6-1.3 34.1-11 48.3-27.9 13.6-16.4 36-23.2 50.9-32.2 7.4-4.5 13.4-10.1 13.9-18.3.4-8.2-4.4-17.3-15.5-29.7zM223.7 87.3c9.8-22.2 34.2-21.8 44-.4 6.5 14.2 3.6 30.9-4.3 40.4-1.6-.8-5.9-2.6-12.6-4.9 1.1-1.2 3.1-2.7 3.9-4.6 4.8-11.8-.2-27-9.1-27.3-7.3-.5-13.9 10.8-11.8 23-4.1-2-9.4-3.5-13-4.4-1-6.9-.3-14.6 2.9-21.8zM183 75.8c10.1 0 20.8 14.2 19.1 33.5-3.5 1-7.1 2.5-10.2 4.6 1.2-8.9-3.3-20.1-9.6-19.6-8.4.7-9.8 21.2-1.8 28.1 1 .8 1.9-.2-5.9 5.5-15.6-14.6-10.5-52.1 8.4-52.1zm-13.6 60.7c6.2-4.6 13.6-10 14.1-10.5 4.7-4.4 13.5-14.2 27.9-14.2 7.1 0 15.6 2.3 25.9 8.9 6.3 4.1 11.3 4.4 22.6 9.3 8.4 3.5 13.7 9.7 10.5 18.2-2.6 7.1-11 14.4-22.7 18.1-11.1 3.6-19.8 16-38.2 14.9-3.9-.2-7-1-9.6-2.1-8-3.5-12.2-10.4-20-15-8.6-4.8-13.2-10.4-14.7-15.3-1.4-4.9 0-9 4.2-12.3zm3.3 334c-2.7 35.1-43.9 34.4-75.3 18-29.9-15.8-68.6-6.5-76.5-21.9-2.4-4.7-2.4-12.7 2.6-26.4v-.2c2.4-7.6.6-16-.6-23.9-1.2-7.8-1.8-15 .9-20 3.5-6.7 8.5-9.1 14.8-11.3 10.3-3.7 11.8-3.4 19.6-9.9 5.5-5.7 9.5-12.9 14.3-18 5.1-5.5 10-8.1 17.7-6.9 8.1 1.2 15.1 6.8 21.9 16l19.6 35.6c9.5 19.9 43.1 48.4 41 68.9zm-1.4-25.9c-4.1-6.6-9.6-13.6-14.4-19.6 7.1 0 14.2-2.2 16.7-8.9 2.3-6.2 0-14.9-7.4-24.9-13.5-18.2-38.3-32.5-38.3-32.5-13.5-8.4-21.1-18.7-24.6-29.9s-3-23.3-.3-35.2c5.2-22.9 18.6-45.2 27.2-59.2 2.3-1.7.8 3.2-8.7 20.8-8.5 16.1-24.4 53.3-2.6 82.4.6-20.7 5.5-41.8 13.8-61.5 12-27.4 37.3-74.9 39.3-112.7 1.1.8 4.6 3.2 6.2 4.1 4.6 2.7 8.1 6.7 12.6 10.3 12.4 10 28.5 9.2 42.4 1.2 6.2-3.5 11.2-7.5 15.9-9 9.9-3.1 17.8-8.6 22.3-15 7.7 30.4 25.7 74.3 37.2 95.7 6.1 11.4 18.3 35.5 23.6 64.6 3.3-.1 7 .4 10.9 1.4 13.8-35.7-11.7-74.2-23.3-84.9-4.7-4.6-4.9-6.6-2.6-6.5 12.6 11.2 29.2 33.7 35.2 59 2.8 11.6 3.3 23.7.4 35.7 16.4 6.8 35.9 17.9 30.7 34.8-2.2-.1-3.2 0-4.2 0 3.2-10.1-3.9-17.6-22.8-26.1-19.6-8.6-36-8.6-38.3 12.5-12.1 4.2-18.3 14.7-21.4 27.3-2.8 11.2-3.6 24.7-4.4 39.9-.5 7.7-3.6 18-6.8 29-32.1 22.9-76.7 32.9-114.3 7.2zm257.4-11.5c-.9 16.8-41.2 19.9-63.2 46.5-13.2 15.7-29.4 24.4-43.6 25.5s-26.5-4.8-33.7-19.3c-4.7-11.1-2.4-23.1 1.1-36.3 3.7-14.2 9.2-28.8 9.9-40.6.8-15.2 1.7-28.5 4.2-38.7 2.6-10.3 6.6-17.2 13.7-21.1.3-.2.7-.3 1-.5.8 13.2 7.3 26.6 18.8 29.5 12.6 3.3 30.7-7.5 38.4-16.3 9-.3 15.7-.9 22.6 5.1 9.9 8.5 7.1 30.3 17.1 41.6 10.6 11.6 14 19.5 13.7 24.6zM173.3 148.7c2 1.9 4.7 4.5 8 7.1 6.6 5.2 15.8 10.6 27.3 10.6 11.6 0 22.5-5.9 31.8-10.8 4.9-2.6 10.9-7 14.8-10.4s5.9-6.3 3.1-6.6-2.6 2.6-6 5.1c-4.4 3.2-9.7 7.4-13.9 9.8-7.4 4.2-19.5 10.2-29.9 10.2s-18.7-4.8-24.9-9.7c-3.1-2.5-5.7-5-7.7-6.9-1.5-1.4-1.9-4.6-4.3-4.9-1.4-.1-1.8 3.7 1.7 6.5z" />
    </svg>
  )
}

function DownloadColumn({
  os,
  title,
  detectedLabel,
  showPlatformIcon,
  flat,
  children,
}: {
  os: DetectedOS
  title: string
  detectedLabel: string | null
  showPlatformIcon: boolean
  flat: boolean
  children: ReactNode
}) {
  return (
    <div className={flat ? "bg-transparent py-1" : "bg-white px-6 py-4"}>
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
  flat,
  onDownload,
}: {
  href: string
  children: ReactNode
  recommended?: boolean
  testId?: string
  openInNewTab: boolean
  keepLabelOnOneLine: boolean
  flat: boolean
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
          ? `inline-flex items-center gap-2 ${flat ? "rounded-xl" : "rounded-lg"} border border-[#07192C] bg-[#07192C] px-3 py-2 text-[12px] font-medium text-white transition-colors hover:border-[#12283F] hover:bg-[#12283F]${keepLabelOnOneLine ? " whitespace-nowrap" : ""}`
          : `inline-flex items-center gap-2 ${flat ? "rounded-xl border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50" : "rounded-lg border-[#DFE5EE] bg-[#F8FAFC] hover:border-[#C9D5E7] hover:bg-[#EEF4FC]"} border px-3 py-2 text-[12px] font-medium text-[#1C2B44] transition-colors${keepLabelOnOneLine ? " whitespace-nowrap" : ""}`
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
  flat,
  recommendedTestId,
  onDownload,
}: {
  detected: DetectedPlatform | null
  groups: DownloadPlatformGroup[]
  openInNewTab: boolean
  customCompanyPresentation: boolean
  flat: boolean
  recommendedTestId?: string
  onDownload?: (option: DownloadPlatformOption) => void
}) {
  return (
    <div className={`grid ${flat ? "gap-x-10 gap-y-6 bg-transparent" : "gap-px border-t border-[#E9EDF3] bg-[#E9EDF3]"} ${customCompanyPresentation ? "lg:grid-cols-3" : "sm:grid-cols-3"}`}>
      {groups.map((group) => (
        <DownloadColumn
          key={group.os}
          os={group.os}
          title={group.title}
          detectedLabel={getDetectedLabel(detected, group.os)}
          showPlatformIcon={customCompanyPresentation}
          flat={flat}
        >
          {group.options.map((option) => (
            <DownloadLink
              key={`${option.label}-${option.href}`}
              href={option.href}
              recommended={isRecommended(detected, group.os, option.arch)}
              testId={isRecommended(detected, group.os, option.arch) ? recommendedTestId : undefined}
              openInNewTab={openInNewTab}
              keepLabelOnOneLine={customCompanyPresentation}
              flat={flat}
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
  variant = "card",
}: {
  groups: DownloadPlatformGroup[]
  openInNewTab?: boolean
  recommendedTestId?: string
  onDownload?: (option: DownloadPlatformOption) => void
  variant?: "card" | "flat"
}) {
  const detected = useDetectedPlatform()

  return (
    <div
      data-testid="download-platform-grid"
      data-detected-os={detected?.os}
      data-detected-arch={detected ? detected.arch ?? "unknown" : undefined}
      data-detection-source={detected?.source}
      className={variant === "flat" ? "overflow-visible" : "overflow-hidden rounded-[14px] border border-[#E3E7EE]"}
    >
      <DownloadPlatformGridContent
        detected={detected}
        groups={groups}
        openInNewTab={openInNewTab}
        customCompanyPresentation
        flat={variant === "flat"}
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
  compact = false,
  appIcon,
}: {
  installers?: DownloadCardInstallers | null
  releaseTag?: string
  /** A single recommended download with the full platform list available on demand. */
  compact?: boolean
  appIcon?: ReactNode
}) {
  const detected = useDetectedPlatform()
  const resolvedInstallers = installers ?? FALLBACK_INSTALLERS
  const tag = releaseTag?.trim()

  if (compact) {
    const groups = groupsForInstallers(resolvedInstallers)
    const detectedGroup = groups.find((group) => group.os === detected?.os)
    const recommended = detected?.arch
      ? detectedGroup?.options.find((option) => option.arch === detected.arch)
      : undefined

    return (
      <section
        data-testid="download-openwork-card"
        data-compact="true"
        data-detected-os={detected?.os}
        data-detected-arch={detected ? detected.arch ?? "unknown" : undefined}
        data-detected-os-version={detected ? detected.osVersion ?? "unknown" : undefined}
        data-detection-source={detected?.source}
        className="overflow-hidden rounded-2xl border border-neutral-200 bg-white"
      >
        <div className="grid gap-4 p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-800">
              {appIcon ?? (detectedGroup ? <PlatformIcon os={detectedGroup.os} className="h-5 w-5" /> : <MonitorIcon className="h-5 w-5" />)}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-neutral-950">OpenWork for your desktop</h3>
              <p className="mt-1 text-xs leading-5 text-neutral-500">
                {recommended && detectedGroup
                  ? `${detectedGroup.title} · ${recommended.label}`
                  : "Choose the version that matches your computer."}
              </p>
            </div>
            {tag ? <span className="shrink-0 text-[11px] leading-5 text-neutral-400">{tag}</span> : null}
          </div>
          {recommended && detectedGroup ? (
            <a
              href={recommended.href}
              target="_blank"
              rel="noreferrer"
              data-testid="download-openwork-link"
              data-download-openwork-link="true"
              data-recommended="true"
              aria-label={`Download OpenWork for ${detectedGroup.title} (${recommended.label})`}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-neutral-950 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
            >
              <DownloadIcon className="h-4 w-4 shrink-0" />
              Download for {detectedGroup.title}
            </a>
          ) : null}
        </div>
        <details className="group border-t border-neutral-200">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-xs font-medium text-neutral-600 hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-neutral-900 [&::-webkit-details-marker]:hidden">
            {recommended ? "Other platforms and versions" : "Choose a download"}
            <span aria-hidden className="text-base leading-none group-open:rotate-45">+</span>
          </summary>
          <div className="grid gap-5 border-t border-neutral-100 px-5 py-4">
            {groups.map((group) => (
              <div key={group.os}>
                <h4 className="mb-2 text-xs font-semibold text-neutral-900">{group.title}</h4>
                <div className="grid gap-1">
                  {group.options.map((option) => (
                    <a
                      key={`${option.label}-${option.href}`}
                      href={option.href}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="download-openwork-link"
                      data-download-openwork-link="true"
                      aria-label={`Download OpenWork for ${group.title} (${option.label})`}
                      className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 py-2 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
                    >
                      {option.label}<DownloadIcon className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      </section>
    )
  }

  return (
    <section
      data-testid="download-openwork-card"
      data-detected-os={detected?.os}
      data-detected-arch={detected ? detected.arch ?? "unknown" : undefined}
      data-detected-os-version={detected ? detected.osVersion ?? "unknown" : undefined}
      data-detection-source={detected?.source}
      className="overflow-hidden rounded-[18px] border border-[#E3E7EE] bg-white shadow-[0_24px_60px_-32px_rgba(7,25,44,0.22)]"
    >
      <div className="bg-linear-to-b/srgb from-[#FAFBFE] to-white px-6 py-5">
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
        flat={false}
      />
    </section>
  )
}
