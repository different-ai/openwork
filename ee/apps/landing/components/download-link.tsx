"use client";

import { detectPlatform, type DownloadCardInstallers } from "@openwork/ui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { automaticDownloadHref } from "../lib/automatic-download";
import { capturePosthogEvent } from "../lib/posthog-client";

const DownloadContext = createContext<(sourcePath: string) => void>(() => {});

export function DownloadProvider({ installers, children }: {
  installers: DownloadCardInstallers;
  children: ReactNode;
}) {
  const detection = useRef<ReturnType<typeof detectPlatform> | null>(null);
  const [download, setDownload] = useState<{ href: string; attempt: number } | null>(null);

  useEffect(() => {
    detection.current = detectPlatform();
  }, []);

  async function startDownload(sourcePath: string) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const detected = await Promise.race([
        detection.current ?? detectPlatform(),
        new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 1500); })
      ]);
      const href = automaticDownloadHref(installers, detected, navigator.userAgent, navigator.maxTouchPoints);
      capturePosthogEvent("desktop_download_clicked", {
        source_path: sourcePath,
        download_url: href,
        os: detected?.os,
        architecture: detected?.arch
      });
      if (href) setDownload((previous) => ({ href, attempt: (previous?.attempt ?? 0) + 1 }));
    } catch {
      // Detection failure leaves the visitor on /download with manual choices.
    } finally {
      clearTimeout(timeout);
    }
  }

  return (
    <DownloadContext.Provider value={startDownload}>
      {children}
      {/* Keep the transfer alive across client navigation to the fallback page. */}
      {download ? <iframe key={download.attempt} src={download.href} title="OpenWork installer download" hidden /> : null}
    </DownloadContext.Provider>
  );
}

export function DownloadLink({ children, className }: { children: ReactNode; className?: string }) {
  const startDownload = useContext(DownloadContext);
  const router = useRouter();

  return (
    <Link
      href="/download"
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        // Preserve campaign attribution without putting replayable download intent
        // in the URL or storage. A visit, prefetch, reload, or Back never starts it.
        void startDownload(window.location.pathname);
        router.push(`/download${window.location.search}`);
      }}
    >
      {children}
    </Link>
  );
}
