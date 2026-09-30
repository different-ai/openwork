"use client";

import { DownloadLink } from "./download-link";

export function HeroDownloadButton() {
  return (
    <DownloadLink className="lp-btn">
      Download OpenWork
      <span className="lp-btn-icon" aria-hidden="true">
        ⤓
      </span>
    </DownloadLink>
  );
}
