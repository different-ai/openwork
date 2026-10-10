import { McpAppFrame } from "@/components/chat/mcp-app-frame";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { McpAppPanelTab } from "../session/panel/panel-tab-store";
import { BuiltAppShareButton } from "./built-app-share-button";
import { builtAppSummary } from "./built-mcp-app-model";

export function BuiltMcpAppPanel({
  tab,
  onClose,
}: {
  tab: McpAppPanelTab;
  onClose: () => void;
}) {
  const summary = builtAppSummary(tab.part);
  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto"
      aria-label={`${tab.label} preview`}
      data-built-app-preview={tab.appId}
    >
      <header className="flex h-10 items-center justify-between border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="" className="size-4 dark:invert" />
          <span className="truncate text-sm font-medium">{tab.label}</span>
          <span role="status" className={`shrink-0 text-xs ${tab.updating ? "text-muted-foreground" : "text-emerald-700 dark:text-emerald-400"}`}>{tab.updating ? "Updating" : "Ready"}</span>
        </div>
        <div className="flex items-center gap-1">
          {!tab.origin.readOnly && summary ? (
            <BuiltAppShareButton
              pluginId={summary.pluginId}
              title={summary.title}
            />
          ) : (
            <Button variant="ghost" size="sm" disabled>
              Share
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close panel"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>
      <div className={`p-3 ${tab.updating ? "opacity-60" : ""}`} aria-busy={tab.updating || undefined}>
        <McpAppFrame part={tab.part} origin={tab.origin} />
      </div>
    </section>
  );
}
