"use client"

import * as React from "react"
import { Check, ExternalLink, KeyRound, LoaderCircle, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tool } from "@/components/ui/tool"
import { useMessageList } from "@/components/chat/message-list-provider"
import type { EnvVarRequestToolPart } from "@/lib/build-in-tools"
import { cn } from "@/lib/utils"
import { EnvironmentEditorFields } from "@/react-app/domains/settings/pages/environment-view"
import {
  useEnvironmentVariableApplyChanges,
  useEnvironmentVariableAvailability,
  useEnvironmentVariableModify,
  useIsEnvironmentVariableChangesPending,
  type EnvironmentEditorDraft,
} from "@/react-app/domains/settings/pages/environment-variable-provider"

interface EnvVarRequestToolProps {
  part: EnvVarRequestToolPart
}

function clean(value: string | undefined) {
  return value?.trim() ?? ""
}

export function EnvVarRequestTool({ part }: EnvVarRequestToolProps) {
  const key = clean(part.input?.key)
  const label = clean(part.input?.label) || key || "environment variable"
  const description = clean(part.input?.description)
  const placeholder = clean(part.input?.placeholder)
  const helpUrl = clean(part.input?.helpUrl)
  const followUpPrompt = clean(part.input?.followUpPrompt)
  const [editor, setEditor] = React.useState<EnvironmentEditorDraft>(() => ({
    mode: "edit",
    key,
    value: "",
  }))
  const [saved, setSaved] = React.useState(false)
  const { canModify, canApplyChanges } = useEnvironmentVariableAvailability()
  const { modifyAsync, isModifying, error: modifyError } = useEnvironmentVariableModify()
  const { applyAsync, isApplying, error: applyError } = useEnvironmentVariableApplyChanges()
  const pendingChanges = useIsEnvironmentVariableChangesPending()
  const { setPrompt } = useMessageList()

  React.useEffect(() => {
    setEditor({ mode: "edit", key, value: "" })
    setSaved(false)
  }, [key])

  if (!key) {
    return <Tool toolPart={part} title="Requested environment variable" />
  }

  const save = () => {
    if (isModifying) return
    void modifyAsync(editor, {
      onSuccess: () => {
        setSaved(true)
        setEditor((current) => ({ ...current, value: "" }))
      },
    })
  }

  const apply = () => {
    if (isApplying) return
    void applyAsync(undefined)
  }

  return (
    <div className="not-prose w-full max-w-xl rounded-2xl border border-dls-border bg-dls-surface/95 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-violet-6/35 bg-violet-3/30 text-violet-11">
          <KeyRound className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-dls-primary">Add {label}</h3>
              {saved ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-green-6/40 bg-green-3/30 px-2 py-0.5 text-[11px] font-medium text-green-11">
                  <Check className="size-3" />
                  Saved
                </span>
              ) : null}
            </div>
            <p className="text-xs leading-5 text-dls-secondary">
              {description || "Paste the token here. OpenWork stores it locally and does not send the secret back into chat."}
            </p>
          </div>

          <EnvironmentEditorFields
            editor={editor}
            onChange={setEditor}
            disabled={!canModify || isModifying}
            error={modifyError}
            keyPlaceholder="NOTION_TOKEN"
            valuePlaceholder={placeholder || "secret_..."}
          />

          {!canModify ? (
            <p className="rounded-lg border border-amber-6/40 bg-amber-3/20 px-3 py-2 text-xs text-amber-11">
              Environment variables can only be edited from a local desktop workspace.
            </p>
          ) : null}
          {applyError ? (
            <p className="rounded-lg border border-red-6/40 bg-red-3/20 px-3 py-2 text-xs text-red-11">
              {applyError.message}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={save} disabled={!canModify || isModifying || !editor.value}>
              {isModifying ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {saved ? "Update token" : "Save token"}
            </Button>
            {canApplyChanges && pendingChanges ? (
              <Button size="sm" variant="outline" onClick={apply} disabled={isApplying}>
                {isApplying ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Apply changes
              </Button>
            ) : null}
            {helpUrl ? (
              <Button size="sm" variant="ghost" render={<a href={helpUrl} target="_blank" rel="noreferrer" />}>
                Open setup guide
                <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
            {followUpPrompt && saved ? (
              <Button size="sm" variant="ghost" onClick={() => setPrompt(followUpPrompt)}>
                Continue setup
              </Button>
            ) : null}
          </div>

          <p className={cn("text-[11px] leading-4 text-dls-tertiary", saved && pendingChanges ? "text-amber-11" : "")}>
            {saved && pendingChanges
              ? "Saved locally. Apply changes so local agents can read the latest value."
              : "The token is written through the same local Environment Variables store used by Settings."}
          </p>
        </div>
      </div>
    </div>
  )
}
