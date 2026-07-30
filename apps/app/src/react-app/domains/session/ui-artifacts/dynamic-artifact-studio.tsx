import * as React from "react"
import {
  ArrowLeft,
  Box,
  CheckCircle2,
  Code2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Wrench,
} from "lucide-react"
import type {
  UiArtifactAttachment,
  UiArtifactProjectFile,
  UiArtifactProjectFiles,
  UiArtifactProjectSnapshot,
  UiArtifactProjectSummary,
  UiArtifactSettings,
} from "@openwork/types/ui-artifact-project"

import {
  OpenworkServerError,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server"
import { ArtifactTextEditor } from "@/react-app/domains/session/artifacts/artifact-text-editor"
import {
  getComposerDraft,
  useComposerStateStore,
} from "@/react-app/domains/session/surface/composer-state-store"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { createDynamicArtifactRendererHost } from "./dynamic-artifact-client-adapter"
import { mergeDynamicArtifactPrompt } from "./dynamic-artifact-attachment"
import { sanitizeDynamicArtifactError } from "./dynamic-artifact-bridge"
import { DynamicArtifactSandboxFrame } from "./dynamic-artifact-sandbox-frame"
import { useDynamicArtifactSelectionStore } from "./dynamic-artifact-selection-store"

const PROJECT_FILES: readonly UiArtifactProjectFile[] = [
  "src/App.tsx",
  "styles.css",
  "data.json",
  "data.schema.json",
  "artifact.json",
]

function editorLanguage(file: UiArtifactProjectFile): "css" | "json" | "tsx" {
  switch (file) {
    case "src/App.tsx":
      return "tsx"
    case "styles.css":
      return "css"
    case "data.json":
    case "data.schema.json":
    case "artifact.json":
      return "json"
  }
}

function shortRevision(revision: string) {
  return revision.replace(/^sha256:/, "").slice(0, 10)
}

function dynamicArtifactSlug(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
}

function structuredServerDiagnostics(error: unknown) {
  if (!(error instanceof OpenworkServerError)) {
    return []
  }
  const details = error.details
  if (
    !details ||
    typeof details !== "object" ||
    !("diagnostics" in details) ||
    !Array.isArray(details.diagnostics)
  ) {
    return []
  }

  return details.diagnostics.slice(0, 20).flatMap((diagnostic) => {
    if (typeof diagnostic === "string") {
      return [sanitizeDynamicArtifactError(diagnostic)]
    }
    if (!diagnostic || typeof diagnostic !== "object") {
      return []
    }
    const location = [
      "path" in diagnostic && typeof diagnostic.path === "string" ? diagnostic.path : null,
      "file" in diagnostic && typeof diagnostic.file === "string" ? diagnostic.file : null,
      "line" in diagnostic && typeof diagnostic.line === "number" ? `line ${diagnostic.line}` : null,
      "column" in diagnostic && typeof diagnostic.column === "number" ? `column ${diagnostic.column}` : null,
    ].filter((value): value is string => value !== null).join(" · ")
    const message = "message" in diagnostic && typeof diagnostic.message === "string"
      ? sanitizeDynamicArtifactError(diagnostic.message)
      : "Artifact validation failed"
    return [`${location ? `${location}: ` : ""}${message}`]
  })
}

function createStarterArtifactFiles(slug: string, title: string, description: string): UiArtifactProjectFiles {
  const manifest = {
    protocol: "openwork.ui-artifact-project",
    schemaVersion: 2,
    apiVersion: 1,
    slug,
    title,
    ...(description.trim() ? { description: description.trim() } : {}),
    runtime: { kind: "react", entry: "src/App.tsx", styles: "styles.css" },
    data: { value: "data.json", schema: "data.schema.json" },
    presentation: {
      placement: "both",
      shape: "summary",
    },
    intents: [],
  }
  const source = `type ArtifactProps = {
  data: { label: string; message: string }
  state: { count?: number } | null
  runtime: { replaceState(next: { count: number }): void }
}

export default function Artifact({ data, state, runtime }: ArtifactProps) {
  const count = state?.count ?? 0
  return (
    <main className="artifact">
      <div>
        <p className="eyebrow">REUSABLE SUMMARY</p>
        <strong>{data.label}</strong>
        <p className="message">{data.message}</p>
      </div>
      <div className="footer">
        <span>{count} interaction{count === 1 ? "" : "s"}</span>
        <button onClick={() => runtime.replaceState({ count: count + 1 })}>
          Update
        </button>
      </div>
    </main>
  )
}
`
  const styles = `:root { font-family: ui-sans-serif, system-ui, sans-serif; color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; }
.artifact { display: flex; width: 100%; height: 100%; flex-direction: column; justify-content: space-between; overflow: hidden; padding: 20px; background: linear-gradient(145deg, #111827, #312e81); color: white; }
.eyebrow { color: #c4b5fd; font-size: 11px; font-weight: 800; letter-spacing: .18em; }
strong { display: block; margin-top: 8px; overflow: hidden; font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
.message { display: -webkit-box; margin: 8px 0 0; overflow: hidden; color: #ddd6fe; font-size: 13px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #c4b5fd; font-size: 11px; }
button { border: 1px solid #a5b4fc; border-radius: 999px; padding: 7px 13px; background: #4338ca; color: white; cursor: pointer; }
`
  const data = { label: "Ready to customize", message: description.trim() || "Ask your agent to shape this compact artifact around your work." }
  const schema = {
    type: "object",
    required: ["label", "message"],
    properties: {
      label: { type: "string", maxLength: 80 },
      message: { type: "string", maxLength: 240 },
    },
    additionalProperties: false,
  }
  return {
    "artifact.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "src/App.tsx": source,
    "styles.css": styles,
    "data.json": `${JSON.stringify(data, null, 2)}\n`,
    "data.schema.json": `${JSON.stringify(schema, null, 2)}\n`,
  }
}

type DynamicArtifactStudioProps = {
  client: OpenworkServerClient
  sessionId: string
  workspaceId: string
}

export function DynamicArtifactStudio(props: DynamicArtifactStudioProps) {
  const selection = useDynamicArtifactSelectionStore((state) => state.selection)
  const selectProject = useDynamicArtifactSelectionStore((state) => state.selectProject)
  const clearSelection = useDynamicArtifactSelectionStore((state) => state.clearSelection)
  const setDraft = useComposerStateStore((state) => state.setDraft)
  const selectedSlug = selection?.workspaceId === props.workspaceId ? selection.slug : null
  const [projects, setProjects] = React.useState<UiArtifactProjectSummary[]>([])
  const [catalogLoading, setCatalogLoading] = React.useState(true)
  const [snapshot, setSnapshot] = React.useState<UiArtifactProjectSnapshot | null>(null)
  const [files, setFiles] = React.useState<UiArtifactProjectFiles | null>(null)
  const [activeFile, setActiveFile] = React.useState<UiArtifactProjectFile>("src/App.tsx")
  const [preview, setPreview] = React.useState<UiArtifactAttachment | null>(
    selection?.workspaceId === props.workspaceId ? selection.attachment ?? null : null,
  )
  const [busy, setBusy] = React.useState<"build" | "save" | null>(null)
  const [diagnostic, setDiagnostic] = React.useState<string | null>(null)
  const [serverDiagnostics, setServerDiagnostics] = React.useState<string[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [settings, setSettings] = React.useState<UiArtifactSettings | null>(null)
  const [settingsBusy, setSettingsBusy] = React.useState(false)
  const [builderSkillStatus, setBuilderSkillStatus] = React.useState<
    "available" | "checking" | "idle" | "unavailable"
  >("idle")
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createTitle, setCreateTitle] = React.useState("")
  const [createDescription, setCreateDescription] = React.useState("")
  const [createBusy, setCreateBusy] = React.useState(false)
  const previewHost = React.useMemo(
    () => preview
      ? createDynamicArtifactRendererHost(props.client, props.workspaceId, preview)
      : null,
    [preview, props.client, props.workspaceId],
  )
  const stagePreviewPrompt = React.useCallback(
    (prompt: string) => {
      const current = getComposerDraft(useComposerStateStore.getState(), props.sessionId)
      setDraft(props.sessionId, mergeDynamicArtifactPrompt(current, prompt))
    },
    [props.sessionId, setDraft],
  )

  const loadProjects = React.useCallback(async () => {
    setCatalogLoading(true)
    try {
      const [result, nextSettings] = await Promise.all([
        props.client.listUiArtifactProjects(props.workspaceId),
        props.client.getUiArtifactSettings(props.workspaceId),
      ])
      setProjects(result.items)
      setSettings(nextSettings)
      if (nextSettings.builderSkillEnabled) {
        setBuilderSkillStatus("checking")
        void props.client.getUiArtifactAgentSkill(props.workspaceId)
          .then(() => setBuilderSkillStatus("available"))
          .catch(() => setBuilderSkillStatus("unavailable"))
      } else {
        setBuilderSkillStatus("idle")
      }
      setError(null)
    } catch (loadError) {
      setError(sanitizeDynamicArtifactError(loadError))
    } finally {
      setCatalogLoading(false)
    }
  }, [props.client, props.workspaceId])

  React.useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  React.useEffect(() => {
    if (!selectedSlug) {
      setSnapshot(null)
      setFiles(null)
      setPreview(null)
      return
    }

    let cancelled = false
    setSnapshot(null)
    setFiles(null)
    setError(null)
    setDiagnostic(null)
    setServerDiagnostics([])
    setPreview(null)

    void props.client.getUiArtifactProject(props.workspaceId, selectedSlug)
      .then((project) => {
        if (!cancelled) {
          setSnapshot(project)
          setFiles(project.files)
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(sanitizeDynamicArtifactError(loadError))
        }
      })

    return () => {
      cancelled = true
    }
  }, [props.client, props.workspaceId, selectedSlug])

  React.useEffect(() => {
    if (
      selection?.workspaceId === props.workspaceId &&
      selection.slug === selectedSlug &&
      selection.attachment
    ) {
      setPreview(selection.attachment)
    }
  }, [props.workspaceId, selectedSlug, selection])

  const persistFiles = React.useCallback(async () => {
    if (!snapshot || !files || !selectedSlug) {
      throw new Error("Artifact project is not loaded")
    }

    if (PROJECT_FILES.every((file) => files[file] === snapshot.files[file])) {
      return snapshot
    }
    const next = await props.client.putUiArtifactProject(
      props.workspaceId,
      selectedSlug,
      {
        files,
        expectedRevision: snapshot.projectRevision,
      },
    )
    setSnapshot(next)
    setFiles(next.files)
    return next
  }, [files, props.client, props.workspaceId, selectedSlug, snapshot])

  const toggleBuilderSkill = async () => {
    if (!settings || settingsBusy) {
      return
    }
    setSettingsBusy(true)
    setError(null)
    try {
      const next = await props.client.updateUiArtifactSettings(props.workspaceId, {
        expectedRevision: settings.settingsRevision,
        builderSkillEnabled: !settings.builderSkillEnabled,
      })
      setSettings(next)
      if (next.builderSkillEnabled) {
        setBuilderSkillStatus("checking")
        void props.client.getUiArtifactAgentSkill(props.workspaceId)
          .then(() => setBuilderSkillStatus("available"))
          .catch(() => setBuilderSkillStatus("unavailable"))
      } else {
        setBuilderSkillStatus("idle")
      }
    } catch (settingsError) {
      setError(sanitizeDynamicArtifactError(settingsError))
    } finally {
      setSettingsBusy(false)
    }
  }

  const toggleProject = async (project: UiArtifactProjectSummary) => {
    if (!settings || settingsBusy) {
      return
    }
    setSettingsBusy(true)
    setError(null)
    try {
      const next = await props.client.updateUiArtifactSettings(props.workspaceId, {
        expectedRevision: settings.settingsRevision,
        project: { slug: project.slug, enabled: !project.enabled },
      })
      setSettings(next)
      await loadProjects()
    } catch (settingsError) {
      setError(sanitizeDynamicArtifactError(settingsError))
    } finally {
      setSettingsBusy(false)
    }
  }

  const createProject = async () => {
    const slug = dynamicArtifactSlug(createTitle)
    if (!slug || !createTitle.trim()) {
      return
    }
    setCreateBusy(true)
    setError(null)
    try {
      const project = await props.client.putUiArtifactProject(
        props.workspaceId,
        slug,
        {
          files: createStarterArtifactFiles(slug, createTitle.trim(), createDescription),
          expectedRevision: null,
        },
      )
      setCreateOpen(false)
      setCreateTitle("")
      setCreateDescription("")
      await loadProjects()
      selectProject({ workspaceId: props.workspaceId, slug: project.manifest.slug })
    } catch (createError) {
      setError(sanitizeDynamicArtifactError(createError))
    } finally {
      setCreateBusy(false)
    }
  }

  const save = async () => {
    setBusy("save")
    setError(null)
    try {
      const next = await persistFiles()
      setDiagnostic(`Saved immutable project revision ${shortRevision(next.projectRevision)}.`)
      await loadProjects()
    } catch (saveError) {
      setError(sanitizeDynamicArtifactError(saveError))
    } finally {
      setBusy(null)
    }
  }

  const rebuild = async () => {
    setBusy("build")
    setError(null)
    setDiagnostic(null)
    setServerDiagnostics([])
    try {
      const next = await persistFiles()
      const instanceId = `studio-${next.manifest.slug}-${shortRevision(next.projectRevision)}`
      const receipt = await props.client.publishUiArtifactProject(
        props.workspaceId,
        next.manifest.slug,
        {
          expectedProjectRevision: next.projectRevision,
          initialState: {},
          instanceId,
          provenance: {
            createdBy: "user",
            sessionId: props.sessionId,
          },
        },
      )
      setPreview(receipt.attachment)
      selectProject({
        workspaceId: props.workspaceId,
        slug: next.manifest.slug,
        attachment: receipt.attachment,
      })
      setDiagnostic(
        `Build ready: ${shortRevision(receipt.build.buildDigest)} · ${receipt.build.bundleBytes.toLocaleString()} bytes · no compiler diagnostics.`,
      )
      await loadProjects()
    } catch (buildError) {
      setError(sanitizeDynamicArtifactError(buildError))
      setServerDiagnostics(structuredServerDiagnostics(buildError))
      setDiagnostic("Build failed. Review the compiler or manifest diagnostic above.")
    } finally {
      setBusy(null)
    }
  }

  const dirty = Boolean(
    snapshot &&
    files &&
    PROJECT_FILES.some((file) => snapshot.files[file] !== files[file]),
  )

  if (!selectedSlug) {
    return (
      <section
        className="space-y-3"
        data-ui-artifact-studio=""
        data-ui-artifact-studio-tab="library"
        aria-label="Generated artifact library"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Generated projects</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Reusable React artifacts stored with this workspace.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" size="xs" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              Create artifact
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => void loadProjects()} aria-label="Refresh generated projects">
              <RefreshCw className={cn("size-3.5", catalogLoading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {error ? (
          <p className="rounded-xl border border-red-6/35 bg-red-3/20 px-3 py-2 text-xs text-red-11">{error}</p>
        ) : null}

        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-3 text-violet-11">
            <Wrench className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">Artifact Builder skill</p>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              {settings?.builderSkillEnabled
                ? "Enabled for agents in this workspace."
                : "Disabled. Existing pinned artifacts still work, but agents cannot build or publish new revisions."}
            </p>
          </div>
          <Badge variant="outline" className="text-[10px]">
            {settings?.builderSkillEnabled
              ? builderSkillStatus === "available"
                ? "Injected"
                : builderSkillStatus === "checking"
                  ? "Checking"
                  : "Unavailable"
              : "Managed"}
          </Badge>
          <Switch
            checked={settings?.builderSkillEnabled === true}
            disabled={!settings || settingsBusy}
            onCheckedChange={() => void toggleBuilderSkill()}
            aria-label={`${settings?.builderSkillEnabled ? "Disable" : "Enable"} Artifact Builder skill`}
          />
        </div>

        {catalogLoading ? (
          <div className="grid min-h-32 place-items-center text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-label="Loading generated projects" />
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border px-5 py-8 text-center">
            <Box className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-foreground">No generated artifacts yet</p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
              Describe the interactive artifact you want in chat. Your agent can create its React project,
              build a safe pinned revision, and keep it here for future edits and reuse.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 @md/ui-artifact-panel:grid-cols-2">
            {projects.map((project) => (
              <article
                key={project.slug}
                className="rounded-2xl border border-border bg-card p-3"
                data-ui-artifact-library-project={project.slug}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => selectProject({ workspaceId: props.workspaceId, slug: project.slug })}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-3 text-violet-11">
                      <Code2 className="size-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{project.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {project.description ?? project.slug}
                      </p>
                    </div>
                  </div>
                </button>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">{shortRevision(project.projectRevision)}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {project.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    <Switch
                      checked={project.enabled}
                      disabled={!settings || settingsBusy}
                      onCheckedChange={() => void toggleProject(project)}
                      aria-label={`${project.enabled ? "Disable" : "Enable"} ${project.title}`}
                    />
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create an artifact</DialogTitle>
              <DialogDescription>
                Start with a safe interactive React template. You or your agent can reshape every file later.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <label className="block space-y-1 text-xs font-medium">
                Name
                <Input
                  value={createTitle}
                  onChange={(event) => setCreateTitle(event.currentTarget.value)}
                  placeholder="Project pulse"
                  autoFocus
                />
              </label>
              <label className="block space-y-1 text-xs font-medium">
                What should it help with?
                <Input
                  value={createDescription}
                  onChange={(event) => setCreateDescription(event.currentTarget.value)}
                  placeholder="Show the status and next steps for my project"
                />
              </label>
              {createTitle.trim() ? (
                <p className="text-[11px] text-muted-foreground">
                  Workspace project: {dynamicArtifactSlug(createTitle) || "choose-a-name"}
                </p>
              ) : null}
            </div>
            <DialogFooter showCloseButton>
              <Button
                type="button"
                disabled={createBusy || !dynamicArtifactSlug(createTitle)}
                onClick={() => void createProject()}
              >
                {createBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                Create and edit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>
    )
  }

  return (
    <section
      className="flex min-h-0 flex-col gap-3"
      data-ui-artifact-studio=""
      data-ui-artifact-studio-tab="editor"
      aria-label="Generated artifact editor"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => clearSelection(props.workspaceId)} aria-label="Back to generated projects">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Library / Editor
          </p>
          <p className="truncate text-sm font-semibold text-foreground">
            {snapshot?.manifest.title ?? selectedSlug}
          </p>
          <p className="truncate text-xs text-muted-foreground">{selectedSlug}</p>
        </div>
        {snapshot ? (
          <>
            <Badge variant="outline" className="text-[10px]">
              {snapshot.enabled ? "Enabled" : "Disabled · editing only"}
            </Badge>
            <Badge
              variant="outline"
              className="font-mono text-[10px]"
              data-ui-artifact-project-revision={snapshot.projectRevision}
            >
              Revision {shortRevision(snapshot.projectRevision)}
            </Badge>
          </>
        ) : null}
        <Button type="button" variant="outline" size="xs" disabled={busy !== null || !snapshot} onClick={() => void save()}>
          {busy === "save" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          Save{dirty ? " •" : ""}
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={
            busy !== null ||
            !snapshot ||
            !snapshot.enabled ||
            settings?.builderSkillEnabled !== true
          }
          title={
            snapshot && !snapshot.enabled
              ? "Enable this project before rebuilding."
              : settings?.builderSkillEnabled !== true
                ? "Enable the Artifact Builder skill before rebuilding."
                : undefined
          }
          onClick={() => void rebuild()}
        >
          {busy === "build" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
          Rebuild
        </Button>
      </div>

      {error ? (
        <p className="rounded-xl border border-red-6/35 bg-red-3/20 px-3 py-2 text-xs text-red-11">{error}</p>
      ) : diagnostic ? (
        <p className="flex items-center gap-2 rounded-xl border border-green-6/35 bg-green-3/20 px-3 py-2 text-xs text-green-11">
          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
          {diagnostic}
        </p>
      ) : null}
      {serverDiagnostics.length > 0 ? (
        <ul className="space-y-1 rounded-xl border border-red-6/35 bg-red-3/10 px-3 py-2 font-mono text-[11px] text-red-11" aria-label="Artifact build diagnostics">
          {serverDiagnostics.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex gap-0.5 overflow-x-auto border-b border-border bg-muted/20 p-1">
          {PROJECT_FILES.map((file) => (
            <button
              key={file}
              type="button"
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground",
                activeFile === file && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => setActiveFile(file)}
            >
              {file}
              {snapshot && files && snapshot.files[file] !== files[file] ? " •" : ""}
            </button>
          ))}
        </div>
        <div className="h-80 min-h-0">
          {files ? (
            <ArtifactTextEditor
              className="h-full"
              value={files[activeFile]}
              language={editorLanguage(activeFile)}
              onChange={(content) => setFiles((current) => (
                current ? { ...current, [activeFile]: content } : current
              ))}
            />
          ) : (
            <div className="grid h-full place-items-center text-xs text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-label="Loading artifact source" />
            </div>
          )}
        </div>
      </div>

      <div data-ui-artifact-studio-preview="">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-foreground">Live sandbox preview</h4>
          {preview ? (
            <span className="text-[10px] font-mono text-muted-foreground">
              pinned {shortRevision(preview.projectRevision)}
            </span>
          ) : null}
        </div>
        {preview && previewHost ? (
          <DynamicArtifactSandboxFrame
            attachment={preview}
            host={previewHost}
            workspaceId={props.workspaceId}
            onStagePrompt={stagePreviewPrompt}
          />
        ) : (
          <div className="grid min-h-36 place-items-center rounded-xl border border-dashed border-border px-4 text-center text-xs leading-5 text-muted-foreground">
            Rebuild to create an immutable preview revision. Existing chat cards remain pinned to their original builds.
          </div>
        )}
      </div>
    </section>
  )
}
