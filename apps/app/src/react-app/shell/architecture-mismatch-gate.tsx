/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, type ReactNode } from "react";

import { isDesktopRuntime } from "../../app/utils";
import { useBootState } from "./boot-state";

type ArchitectureInfo = {
  appArch: string;
  appArchLabel: string;
  systemArch: string;
  systemArchLabel: string;
  mismatch: boolean;
  platform: "darwin" | "linux" | "windows";
  version: string;
  downloadUrl: string;
  releaseUrl: string;
};

type ArchitectureMismatchGateProps = {
  children: ReactNode;
};

type ArchitectureGateState = {
  info: ArchitectureInfo | null;
  checked: boolean;
};

type ArchitectureGateAction =
  | { type: "checked" }
  | { type: "resolved"; info: ArchitectureInfo };

function architectureGateReducer(
  state: ArchitectureGateState,
  action: ArchitectureGateAction,
): ArchitectureGateState {
  switch (action.type) {
    case "checked":
      return { ...state, checked: true };
    case "resolved":
      return { info: action.info, checked: true };
  }
}

function platformLabel(platform: ArchitectureInfo["platform"]): string {
  if (platform === "darwin") return "macOS";
  if (platform === "windows") return "Windows";
  return "Linux";
}

export function ArchitectureMismatchGate({ children }: ArchitectureMismatchGateProps) {
  const { markRouteReady } = useBootState();
  const [state, dispatch] = useReducer(architectureGateReducer, {
    info: null,
    checked: !isDesktopRuntime(),
  });
  const { info, checked } = state;

  useEffect(() => {
    let cancelled = false;
    const bridge = window.__OPENWORK_ELECTRON__?.system?.getArchitectureInfo;
    if (!bridge) {
      dispatch({ type: "checked" });
      return;
    }

    void bridge()
      .then((nextInfo) => {
        if (cancelled) return;
        dispatch({ type: "resolved", info: nextInfo });
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[architecture-gate] failed to resolve runtime architecture", error);
        dispatch({ type: "checked" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (info?.mismatch) markRouteReady();
  }, [info?.mismatch, markRouteReady]);

  const openDownload = useCallback(() => {
    const url = info?.downloadUrl || info?.releaseUrl;
    if (!url) return;
    void window.__OPENWORK_ELECTRON__?.shell?.openExternal?.(url);
  }, [info?.downloadUrl, info?.releaseUrl]);

  const openRelease = useCallback(() => {
    if (!info?.releaseUrl) return;
    void window.__OPENWORK_ELECTRON__?.shell?.openExternal?.(info.releaseUrl);
  }, [info?.releaseUrl]);

  if (!checked) return null;
  if (!info?.mismatch) return <>{children}</>;

  return (
    <main className="min-h-screen bg-[#05070c] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-6 py-12">
        <section className="w-full overflow-hidden rounded-[32px] border border-white/10 bg-white/[0.04] shadow-2xl shadow-black/40">
          <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-8 p-8 sm:p-10 lg:p-12">
              <div className="inline-flex rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-amber-100">
                Architecture mismatch
              </div>
              <div className="space-y-4">
                <h1 className="max-w-2xl text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
                  Install the correct OpenWork build
                </h1>
                <p className="max-w-2xl text-base leading-7 text-white/72 sm:text-lg">
                  Your application is running the {info.appArchLabel} version of OpenWork, but this {platformLabel(info.platform)} system is {info.systemArchLabel}. This may cause unpredictable issues.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-white/40">Running app</div>
                  <div className="mt-2 text-2xl font-semibold text-white">{info.appArchLabel}</div>
                  <div className="mt-1 font-mono text-xs text-white/45">{info.appArch}</div>
                </div>
                <div className="rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/70">Your system</div>
                  <div className="mt-2 text-2xl font-semibold text-emerald-50">{info.systemArchLabel}</div>
                  <div className="mt-1 font-mono text-xs text-emerald-100/55">{info.systemArch}</div>
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={openDownload}
                  className="inline-flex items-center justify-center rounded-full bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-emerald-100"
                >
                  Download correct version
                </button>
                <button
                  type="button"
                  onClick={openRelease}
                  className="inline-flex items-center justify-center rounded-full border border-white/14 px-5 py-3 text-sm font-semibold text-white/85 transition hover:bg-white/10"
                >
                  Open release page
                </button>
              </div>
            </div>

            <aside className="border-t border-white/10 bg-gradient-to-br from-emerald-300/12 via-sky-300/8 to-transparent p-8 sm:p-10 lg:border-l lg:border-t-0 lg:p-12">
              <div className="space-y-5 rounded-[28px] border border-white/10 bg-black/25 p-6 text-sm leading-6 text-white/68">
                <div className="text-lg font-semibold text-white">Why OpenWork stopped here</div>
                <p>
                  OpenWork blocks startup when the installed app architecture does not match the machine architecture. This prevents runtime sidecars, browser tooling, and update downloads from continuing on the wrong build.
                </p>
                <p>
                  After installing the correct {info.systemArchLabel} build, quit this copy and launch OpenWork again. Your workspaces and settings are kept in the same app data folder.
                </p>
                <div className="rounded-2xl bg-white/[0.06] p-4 font-mono text-xs text-white/55">
                  v{info.version} · {platformLabel(info.platform)} · {info.systemArch}
                </div>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}
