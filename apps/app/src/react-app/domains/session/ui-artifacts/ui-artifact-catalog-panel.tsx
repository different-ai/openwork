import * as React from "react"
import {
  BellRing,
  CalendarDays,
  ClipboardCheck,
  LayoutDashboard,
  Mail,
  MessageSquareText,
  Sparkles,
  TrendingUp,
  Code2,
  X,
} from "lucide-react"
import type { UiArtifactKind } from "@openwork/types/ui-artifact"

import type { OpenworkServerClient } from "@/app/lib/openwork-server"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { t } from "@/i18n"
import { STANDARD_UI_ARTIFACTS } from "@/lib/ui-artifact-catalog"
import { cn } from "@/lib/utils"
import { useFeatureFlagsPreferences } from "@/react-app/domains/settings/state/feature-flags-preferences"
import { DynamicArtifactStudio } from "./dynamic-artifact-studio"

function artifactIcon(artifactId: UiArtifactKind) {
  switch (artifactId) {
    case "workspace.brief":
      return LayoutDashboard
    case "widgets.collection":
      return TrendingUp
    case "calendar.view":
      return CalendarDays
    case "communication.thread":
      return MessageSquareText
    case "mail.inbox":
      return Mail
    case "work.attention":
      return BellRing
    case "work.approvals":
      return ClipboardCheck
  }
}

function artifactTone(artifactId: UiArtifactKind) {
  switch (artifactId) {
    case "workspace.brief":
      return "bg-indigo-3 text-indigo-11"
    case "widgets.collection":
      return "bg-purple-3 text-purple-11"
    case "calendar.view":
      return "bg-blue-3 text-blue-11"
    case "communication.thread":
      return "bg-violet-3 text-violet-11"
    case "mail.inbox":
      return "bg-orange-3 text-orange-11"
    case "work.attention":
      return "bg-red-3 text-red-11"
    case "work.approvals":
      return "bg-green-3 text-green-11"
  }
}

function ArtifactCatalogTile(props: {
  artifactId: UiArtifactKind
  label: string
  description: string
  sources: readonly string[]
  enabled: boolean
  onToggle: () => void
}) {
  const Icon = artifactIcon(props.artifactId)

  return (
    <article
      className={cn(
        "flex min-h-48 flex-col rounded-2xl border p-4 transition-colors",
        props.enabled
          ? "border-primary/25 bg-primary/[0.035]"
          : "border-border bg-card hover:bg-muted/20",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className={cn("flex size-10 items-center justify-center rounded-xl", artifactTone(props.artifactId))}>
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <Switch
          checked={props.enabled}
          onCheckedChange={props.onToggle}
          aria-label={`${props.enabled ? "Disable" : "Enable"} ${props.label}`}
        />
      </div>

      <div className="mt-4 min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-sm font-semibold text-foreground">{props.label}</h3>
          {props.enabled ? (
            <Badge variant="outline" className="border-green-6/50 bg-green-3/40 text-green-11">
              Enabled
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{props.description}</p>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {props.sources.map((source) => (
          <span key={source} className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {source}
          </span>
        ))}
      </div>
    </article>
  )
}

type UiArtifactCatalogPanelProps = {
  client: OpenworkServerClient
  onClose: () => void
  sessionId: string
  workspaceId: string
}

export function UiArtifactCatalogPanel({
  client,
  onClose,
  sessionId,
  workspaceId,
}: UiArtifactCatalogPanelProps) {
  const [catalogKind, setCatalogKind] = React.useState<"generated" | "standard">("generated")
  const {
    enabledUiArtifactIds,
    toggleUiArtifact,
  } = useFeatureFlagsPreferences()
  const enabledCount = STANDARD_UI_ARTIFACTS.filter((definition) => (
    enabledUiArtifactIds.includes(definition.artifactId)
  )).length

  return (
    <section className="@container/ui-artifact-panel flex h-full min-h-0 flex-col bg-background" aria-label="UI artifacts">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <LayoutDashboard className="size-4.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">UI artifacts</h2>
            <Badge variant="outline" className="border-amber-6/50 bg-amber-3/40 text-amber-11">Alpha</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {catalogKind === "generated"
              ? "React projects your agents can build and evolve"
              : `${enabledCount} of ${STANDARD_UI_ARTIFACTS.length} standard artifacts enabled`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close UI artifacts">
          <X />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-muted/50 p-1" role="tablist" aria-label="Artifact catalogs">
          <button
            type="button"
            role="tab"
            aria-selected={catalogKind === "generated"}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground",
              catalogKind === "generated" && "bg-background text-foreground shadow-xs",
            )}
            onClick={() => setCatalogKind("generated")}
          >
            <Code2 className="size-3.5" aria-hidden="true" />
            Generated
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={catalogKind === "standard"}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground",
              catalogKind === "standard" && "bg-background text-foreground shadow-xs",
            )}
            onClick={() => setCatalogKind("standard")}
          >
            <LayoutDashboard className="size-3.5" aria-hidden="true" />
            Standard
          </button>
        </div>

        {catalogKind === "generated" ? (
          <DynamicArtifactStudio
            client={client}
            workspaceId={workspaceId}
            sessionId={sessionId}
          />
        ) : (
          <>
            <div className="mb-4 rounded-2xl border border-violet-6/30 bg-violet-3/25 p-3">
              <div className="flex items-start gap-2.5">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-violet-11" aria-hidden="true" />
                <div>
                  <p className="text-xs font-medium text-foreground">Native answer prototypes</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    These member-level switches control both capability suggestions and validated native cards.
                    Suggestions are added only to successful execute_capability results and work with any compatible agent engine.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 @md/ui-artifact-panel:grid-cols-2">
              {STANDARD_UI_ARTIFACTS.map((definition) => (
                <ArtifactCatalogTile
                  key={definition.artifactId}
                  artifactId={definition.artifactId}
                  label={t(definition.labelKey)}
                  description={t(definition.descriptionKey)}
                  sources={definition.sources}
                  enabled={enabledUiArtifactIds.includes(definition.artifactId)}
                  onToggle={() => toggleUiArtifact(definition.artifactId)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
