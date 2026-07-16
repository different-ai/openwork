"use client";

import { useEffect, useState } from "react";

export function parseDenRuntimeVersion(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const version = Object.getOwnPropertyDescriptor(value, "version")?.value;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

export function DenRuntimeVersionLabel({ version }: { version: string }) {
  return (
    <span
      className="font-normal tabular-nums text-gray-300"
      data-den-runtime-version={version}
      title={`Den API version ${version}`}
    >
      Den {version}
    </span>
  );
}

export function DenRuntimeVersion() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadVersion() {
      try {
        const response = await fetch("/api/den/health", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          return;
        }

        const nextVersion = parseDenRuntimeVersion(await response.json());
        if (!controller.signal.aborted) {
          setVersion(nextVersion);
        }
      } catch {
        // Version metadata is optional UI; the page remains quiet when
        // den-api is unavailable or an older deployment omits the field.
      }
    }

    void loadVersion();
    return () => controller.abort();
  }, []);

  return version ? <DenRuntimeVersionLabel version={version} /> : null;
}
