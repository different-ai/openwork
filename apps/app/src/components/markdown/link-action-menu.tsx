/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Eye, FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

import type { DesktopApplication } from "@/app/lib/desktop";
import { getDesktopApplicationsForFile, openDesktopWithApp } from "@/app/lib/desktop";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { usePlatform } from "@/react-app/kernel/platform";
import { useOpenTargets, type OpenTargetOptions } from "@/lib/target-provider";
import { localArtifactPath, nativeFileAction } from "@/react-app/domains/session/artifacts/resolve-open-target";

const SUPPORTED_PANEL_PREVIEWS = new Set(["markdown", "code", "sheet", "slides", "image", "pdf", "html", "text"]);

type LinkActionMenuProps = {
  target: OpenTarget;
  anchorRect: DOMRect;
  onOpenTarget: (target: OpenTarget, options?: OpenTargetOptions) => void;
  onClose: () => void;
};

export function LinkActionMenu({ target, anchorRect, onOpenTarget, onClose }: LinkActionMenuProps) {
  const platform = usePlatform();
  const menuRef = useRef<HTMLDivElement>(null);
  const [apps, setApps] = useState<DesktopApplication[] | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);
  const canOpenInPanel = target.kind === "file" && SUPPORTED_PANEL_PREVIEWS.has(target.preview);
  const { workspaceRoot, isLocalWorkspace } = useOpenTargets();
  const native = isLocalWorkspace && platform.capabilities.revealInFileManager && target.kind === "file"
    ? nativeFileAction(workspaceRoot, target.value) : null;
  const canOpenExternally = native !== null;
  const canLaunch = native?.action === "open";
  const nativePath = native?.path;
  const copyPath = localArtifactPath(workspaceRoot, target.value) ?? target.value;

  useEffect(() => {
    const previous = document.activeElement;
    menuRef.current?.querySelector("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  useEffect(() => {
    if (!canLaunch || !nativePath) return;
    setAppsLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const result = await getDesktopApplicationsForFile(nativePath);
        if (!cancelled) {
          setApps(result.slice(0, 12));
        }
      } catch {
        if (!cancelled) setApps([]);
      } finally {
        if (!cancelled) setAppsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canLaunch, nativePath]);

  const handleOpenDefault = () => {
    onOpenTarget(target, { external: true });
    onClose();
  };

  const handleOpenInPanel = () => {
    onOpenTarget(target);
    onClose();
  };

  const handleReveal = () => {
    onOpenTarget(target, { external: true, reveal: true });
    onClose();
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(copyPath);
      onClose();
    } catch {
      toast.error("Could not copy the path. Try again.");
    }
  };

  const handleOpenWithApp = async (app: DesktopApplication) => {
    if (!canLaunch || !nativePath || !workspaceRoot) return;
    try {
      await openDesktopWithApp(nativePath, app.appPath, workspaceRoot);
      onClose();
    } catch {
      toast.error("Could not open this file. Try another app or reveal it in the file manager.");
    }
  };

  const top = anchorRect.bottom + 4;
  const left = anchorRect.left;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-52 rounded-lg border border-border bg-popover/95 p-1 shadow-lg backdrop-blur-xl"
      style={{ top, left }}
    >
      {target.kind === "file" ? (
        <Button
          variant="ghost"
          onClick={() => void handleCopyPath()}
          className="w-full justify-start gap-2.5 px-3 py-2 text-sm"
        >
          <Copy className="size-4 shrink-0" />
          Copy path
        </Button>
      ) : null}
      {canLaunch ? (
        <button
          type="button"
          onClick={handleOpenDefault}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-foreground/10"
        >
          <ExternalLink className="size-4 shrink-0" />
          Open with default app
        </button>
      ) : null}
      {canOpenInPanel ? (
        <button
          type="button"
          onClick={handleOpenInPanel}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-foreground/10"
        >
          <Eye className="size-4 shrink-0" />
          Open in panel
        </button>
      ) : null}
      {canOpenExternally ? (
        <button
          type="button"
          onClick={handleReveal}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-foreground/10"
        >
          <FolderOpen className="size-4 shrink-0" />
          {platform.os === "macos" ? "Reveal in Finder" : "Show in folder"}
        </button>
      ) : null}
      {canLaunch && apps && apps.length > 0 ? (
        <>
          <div className="my-1 h-px bg-foreground/5" />
          <div className="max-h-48 overflow-y-auto">
            {apps.map((app) => (
              <button
                key={app.appPath}
                type="button"
                onClick={() => void handleOpenWithApp(app)}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                {app.icon ? (
                  <img src={app.icon} alt="" className="size-4 shrink-0 object-contain" />
                ) : (
                  <span className="size-4 shrink-0" />
                )}
                <span className="truncate">{app.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : appsLoading ? (
        <>
          <div className="my-1 h-px bg-foreground/5" />
          <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            Loading apps…
          </div>
        </>
      ) : null}
    </div>
  );
}
