"use client";

import { detectPlatform, type DetectedOS } from "@openwork/ui/react";
import { useEffect, useState } from "react";

import { DownloadLink } from "./download-link";

const osLabel: Record<DetectedOS, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux"
};

export function HeroDownloadButton() {
  const [os, setOs] = useState<DetectedOS | null>(null);

  useEffect(() => {
    let cancelled = false;
    void detectPlatform().then((detected) => {
      if (!cancelled && detected) setOs(detected.os);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DownloadLink className="lp-btn">
      {os ? `Download for ${osLabel[os]}` : "Download for free"}
      <span className="lp-btn-icon" aria-hidden="true">
        ⤓
      </span>
    </DownloadLink>
  );
}
