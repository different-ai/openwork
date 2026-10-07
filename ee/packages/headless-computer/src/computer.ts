import { createHash } from "node:crypto"
import { posix } from "node:path"
import { ensureRunning, isSandboxError, SCOPE_LABEL, withBlocks, type RunSpec, type SandboxHandle, type SandboxProvider, type SandboxSpec } from "@openwork/sandbox"
import { z } from "zod"
import type { ComputerFile, ComputerFiles, FileReader, ToolResult, ToolSpec } from "./types.js"

/** One provider-neutral Linux computer per conversation. Jobs own idle policy and files; adapters own transport. */
export type ComputerOptions = {
  provider: SandboxProvider
  /** Existing Freestyle computers keep their hc-<hash> identity. */
  scope?: string
  idlePauseMs: number
  keepDays: number
}

const WORKSPACE = "/workspace"
const FILES_DIR = `${WORKSPACE}/files`
const OUT_DIR = `${WORKSPACE}/out`
/** Which /workspace/out files were already added to the person's Files (path → size:mtime), kept in the VM itself. */
const EXPORTED_MANIFEST = `${WORKSPACE}/.jobs/.exported.json`
const MANIFEST_MARKER = "---computer-exported---"
/** What a login shell would set, so `pip install --user` and npm globals are found without the slow profile. */
function computerBlocks(provider: SandboxProvider) { return withBlocks(provider, ["run", "files"], "Workbot computer") }
const GUEST_PATH = "/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
/** The longest a single command may run; Freestyle's exec limit. Longer work goes through `background`. */
const MAX_COMMAND_SECONDS = 300
const DEFAULT_COMMAND_SECONDS = 120
/** Each of stdout and stderr is cut to its last this-many characters: errors and results are at the end. */
const OUTPUT_TAIL_CHARS = 30_000
/** Files larger than this are not opened by `look` nor copied to the person's Files automatically. */
const MAX_LOOK_BYTES = 25 * 1024 * 1024
const MAX_EXPORT_BYTES = 200 * 1024 * 1024
/** Files that get a PDF preview rendered when they reach the person's Files. */
const PREVIEWABLE = /\.(pptx|ppt|docx|doc|odp|odt|key|pages|pdf)$/i
const MAX_PREVIEW_PAGES = 60
export const canPreview = (name: string) => PREVIEWABLE.test(name)
/** What renders those previews; part of the prepared image, installed on older computers when first needed. */
const OFFICE_PACKAGES = "fonts-liberation fonts-noto-core libreoffice-impress-nogui libreoffice-writer-nogui libreoffice-calc-nogui"

export class Computers {
  private readonly provider: SandboxProvider
  private readonly blocks: ReturnType<typeof computerBlocks>
  /** Sessions whose VM this process has resolved: the handle, so later calls skip the lookup. */
  private readonly vms = new Map<string, Promise<SandboxHandle>>()
  private readonly pauseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Saved file ids already copied into each session's VM by this process. */
  private readonly copied = new Map<string, Set<string>>()

  private readonly snapshot: string
  private readonly files?: ComputerFiles
  private readonly readFile: FileReader

  /** What the model is told about its computer, and the tools it gets; see COMPUTER_PROMPT and COMPUTER_TOOLS. */
  readonly prompt = COMPUTER_PROMPT
  readonly tools: ToolSpec[] = COMPUTER_TOOLS
  readonly toolNames: ReadonlySet<string> = COMPUTER_TOOL_NAMES

  /**
   * `files` is the conversation's kept files (uploads in, outputs out); without it the computer only runs commands.
   * `readFile` turns a file into what the model can see (images, PDFs, text), the same way tool results are read.
   */
  constructor(private readonly options: ComputerOptions, deps: { files?: ComputerFiles; readFile: FileReader }) {
    this.provider = options.provider
    this.blocks = computerBlocks(this.provider)
    this.snapshot = this.provider.currentImage()?.id ?? "configured image"
    this.files = deps.files
    this.readFile = deps.readFile
  }

  /** Runs one of the computer's tools (`bash` or `look`) for a conversation. */
  run(sessionId: string, name: string, input: Record<string, unknown>): Promise<ToolResult> {
    return runComputerTool(this, sessionId, name, input)
  }

  /** The snapshot new computers boot from, for logs. */
  get image() {
    return this.snapshot
  }

  /** The VM's slug: stable per session, opaque, and within Freestyle's 63-character limit. */
  slug(sessionId: string) {
    return `hc-${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`
  }

  /** Whether this conversation has used its computer since the runner started. */
  known(sessionId: string) {
    return this.vms.has(sessionId)
  }

  /** Starts (or wakes) the conversation's VM in the background, so the first command doesn't wait for it. */
  prewarm(sessionId: string) {
    void this.vm(sessionId)
      .then((box) => this.execute(box, { command: "true", timeoutMs: 10_000 }))
      .catch(() => undefined)
  }

  /** The conversation's VM, created from the snapshot on first use. A paused VM wakes on its next command. */
  async vm(sessionId: string): Promise<SandboxHandle> {
    this.cancelPause(sessionId)
    let pending = this.vms.get(sessionId)
    if (!pending) {
      pending = this.resolve(sessionId)
      this.vms.set(sessionId, pending)
      pending.catch(() => this.vms.delete(sessionId))
      return pending
    }
    const current = await this.provider.inspect(await pending)
    if (current.state === "running") return current
    if (current.state === "missing") this.copied.delete(sessionId)
    const waking = this.resolve(sessionId)
    this.vms.set(sessionId, waking)
    return waking
  }

  private spec(sessionId: string): SandboxSpec {
    return {
      idempotencyKey: this.slug(sessionId), image: this.provider.currentImage(),
      labels: { kind: "headless-computer", ...(this.options.scope ? { [SCOPE_LABEL]: this.options.scope } : {}) },
      env: {}, storage: [], exposePorts: [],
      // The job's own timer checks background jobs. Keep the provider's idle
      // backstop long enough that a quiet rendering job does not get stopped.
      lifecycle: { autoStopMinutes: 60, autoDeleteMinutes: this.options.keepDays * 1440 },
    }
  }

  private resolve(sessionId: string): Promise<SandboxHandle> {
    return ensureRunning(this.provider, this.spec(sessionId), { timeoutMs: 120_000 })
  }

  private execute(box: SandboxHandle, spec: RunSpec) {
    return this.blocks.run(box, spec)
  }

  /** Recover before launching work; never retry an unknown command outcome. */
  private async exec(sessionId: string, command: string, timeoutSeconds: number) {
    const box = await this.vm(sessionId)
    return this.execute(box, {
      command: `cd ${WORKSPACE} 2>/dev/null || cd ~; exec bash -c "$WORKBOT_COMMAND"`,
      env: { WORKBOT_COMMAND: command, PATH: GUEST_PATH, HOME: "/home/ubuntu", LANG: "C.UTF-8" },
      timeoutMs: timeoutSeconds * 1000,
    })
  }

  /** Pauses the VM once the conversation has been quiet for a while, unless a background job is still running. */
  release(sessionId: string) {
    if (!this.vms.has(sessionId)) return
    this.cancelPause(sessionId)
    const timer = setTimeout(() => void this.pauseIfIdle(sessionId), this.options.idlePauseMs)
    timer.unref?.()
    this.pauseTimers.set(sessionId, timer)
  }

  private async pauseIfIdle(sessionId: string) {
    this.pauseTimers.delete(sessionId)
    const pending = this.vms.get(sessionId)
    if (!pending) return
    try {
      const vm = await pending
      const jobs = await this.execute(vm, { command: `ls ${WORKSPACE}/.jobs/*.running 2>/dev/null | wc -l`, timeoutMs: 10_000 })
      if (Number(jobs.stdout?.trim() ?? "0") > 0) return this.release(sessionId)
      await (this.provider.blocks?.pause ? this.provider.blocks.pause(vm, { timeoutMs: 30_000 }) : this.provider.stop(vm, { timeoutMs: 30_000 }))
    } catch {
      // Not fatal: Freestyle's own idle timeout pauses it later.
    }
  }

  private cancelPause(sessionId: string) {
    const timer = this.pauseTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.pauseTimers.delete(sessionId)
  }

  /** Deletes the conversation's VM, if it has one. */
  async delete(sessionId: string) {
    this.cancelPause(sessionId)
    this.vms.delete(sessionId)
    this.copied.delete(sessionId)
    const box = await this.provider.find({ idempotencyKey: this.slug(sessionId), labels: this.spec(sessionId).labels })
    if (box) await this.provider.destroy(box, { timeoutMs: 30_000 }).catch((error: unknown) => {
      if (!isSandboxError(error) || error.code !== "not_found") throw error
    })
  }

  /** Copies files the person sent into /workspace/files. Returns the paths it copied this time. */
  private async copyUploads(sessionId: string): Promise<string[]> {
    if (!this.files) return []
    const done = this.copied.get(sessionId) ?? new Set<string>()
    this.copied.set(sessionId, done)
    const pending = this.files.list(sessionId).filter((file) => file.source === "user" && !done.has(file.id))
    if (pending.length === 0) return []
    const vm = await this.vm(sessionId)
    const copied: string[] = []
    for (const file of pending) {
      const path = await this.uploadPath(vm, file.name, file.size)
      if (path.exists) {
        done.add(file.id)
        continue
      }
      const found = await this.files.read(sessionId, file.id)
      if (!found) {
        done.add(file.id)
        continue
      }
      await this.blocks.files.write(vm, path.path, found.bytes, { timeoutMs: 30_000 })
      done.add(file.id)
      copied.push(path.path)
    }
    return copied
  }

  /** `/workspace/files/<name>`, or a variant when a different file already has that name. */
  private async uploadPath(vm: SandboxHandle, name: string, size: number) {
    const base = posix.basename(name) || "file"
    const extension = posix.extname(base)
    const stem = base.slice(0, base.length - extension.length)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const path = `${FILES_DIR}/${attempt === 0 ? base : `${stem} (${attempt + 1})${extension}`}`
      const stat = await this.blocks.files.stat(vm, path, { timeoutMs: 10_000 })
      if (!stat) return { path, exists: false }
      if (stat.size === size) return { path, exists: true }
    }
    return { path: `${FILES_DIR}/${Date.now()}-${base}`, exists: false }
  }

  /** Adds new or changed files under /workspace/out to the person's Files. Returns their names. */
  /** Adds new or changed files in /workspace/out to the person's files. Returns what was added, and what wasn't. */
  private async exportOutputs(sessionId: string): Promise<{ saved: string[]; skipped: string[] }> {
    if (!this.files) return { saved: [], skipped: [] }
    const maxBytes = Math.min(MAX_EXPORT_BYTES, this.files.maxFileBytes)
    const vm = await this.vm(sessionId)
    const listing = await this.execute(vm, {
      command: `find ${OUT_DIR} -type f -not -name '.*' -printf '%P\\t%s\\t%T@\\n' 2>/dev/null; echo '${MANIFEST_MARKER}'; cat ${EXPORTED_MANIFEST} 2>/dev/null || echo '{}'`,
      timeoutMs: 30_000,
    })
    const [listed = "", manifestText = "{}"] = (listing.stdout ?? "").split(`${MANIFEST_MARKER}\n`)
    // path → "size:mtime|fileId": the version last added, and the saved file it became.
    const manifest = z.record(z.string(), z.string()).catch({}).parse(safeJson(manifestText.trim()))
    const saved: string[] = []
    const skipped: string[] = []
    let changed = false
    for (const line of listed.split("\n").filter(Boolean)) {
      const [relative, sizeText, mtime] = line.split("\t")
      if (!relative || !sizeText) continue
      const size = Number(sizeText)
      const signature = `${size}:${mtime}`
      const [previousSignature, recordedId] = (manifest[relative] ?? "").split("|")
      if (previousSignature === signature) continue
      // Outputs recorded before ids were kept: the newest file it made under that name is the earlier version.
      const previousId = recordedId || (previousSignature ? this.files.list(sessionId).find((file) => file.source === "agent" && file.name === posix.basename(relative))?.id : undefined)
      // A version that doesn't fit is recorded as seen, so it is reported once rather than after every command.
      const notKept = (reason: string) => {
        skipped.push(`${relative} (${reason})`)
        manifest[relative] = `${signature}|${previousId ?? ""}`
        changed = true
      }
      if (size > maxBytes) {
        notKept(`${formatBytes(size)}; the most a kept file can be is ${formatBytes(maxBytes)}`)
        continue
      }
      const bytes = new Uint8Array(await this.blocks.files.read(vm, `${OUT_DIR}/${relative}`, { timeoutMs: 30_000 }))
      // A new version of a file already handed over updates it in place: one file in their Files, and anything
      // showing it (the answer's card, an open preview) moves to the new version.
      let file: ComputerFile | null = null
      try {
        file =
          (previousId ? await this.files.replace(sessionId, previousId, { bytes }) : null) ??
          (await this.files.add(sessionId, { name: posix.basename(relative), bytes, source: "agent" }))
      } catch (error) {
        // Over the conversation's limits: final for this version. Anything else (storage briefly unreachable)
        // is left unrecorded, so the next command tries again.
        if (isLimitError(error)) {
          notKept(error.message)
          continue
        }
        throw error
      }
      manifest[relative] = `${signature}|${file.id}`
      changed = true
      saved.push(file.name)
      // Slides, documents and PDFs get page images for the preview panel, made in the background.
      if (canPreview(relative)) void this.renderPreview(sessionId, file.id, `${OUT_DIR}/${relative}`).catch(() => undefined)
    }
    if (changed) await this.blocks.files.write(vm, EXPORTED_MANIFEST, new TextEncoder().encode(JSON.stringify(manifest)), { timeoutMs: 30_000 })
    return { saved, skipped }
  }

  /** Renders a kept file's preview on demand (files from before previews, or ones the person sent). */
  async previewSavedFile(sessionId: string, fileId: string) {
    if (!this.files) return
    const found = await this.files.read(sessionId, fileId)
    if (!found || !canPreview(found.file.name)) return
    const vm = await this.vm(sessionId)
    const extension = posix.extname(found.file.name).toLowerCase()
    const path = `/tmp/computer-preview/source/${fileId}${extension}`
    await this.execute(vm, { command: "mkdir -p /tmp/computer-preview/source", timeoutMs: 10_000 })
    await this.blocks.files.write(vm, path, found.bytes, { timeoutMs: 30_000 })
    await this.renderPreview(sessionId, fileId, path)
  }

  /** Renders an Office file with LibreOffice on the computer and keeps its pages as images, the file's preview. */
  private async renderPreview(sessionId: string, fileId: string, path: string) {
    if (!this.files) return
    // The version being rendered: if the file is revised meanwhile, these pages are stale and are not kept.
    const version = this.files.list(sessionId).find((file) => file.id === fileId)?.updatedAt
    const vm = await this.vm(sessionId)
    // A computer made from an older image has no LibreOffice yet: install it once, quietly, instead of
    // replacing the computer and its files.
    const has = await this.execute(vm, { command: "command -v soffice >/dev/null && echo yes", timeoutMs: 10_000 })
    if (has.stdout?.trim() !== "yes" && !path.toLowerCase().endsWith(".pdf")) {
      await this.execute(vm, {
        command: `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${OFFICE_PACKAGES} >/dev/null 2>&1`,
        timeoutMs: 290_000,
      })
    }
    const outDir = `/tmp/computer-preview/${fileId}`
    // PDFs are paged as they are; Office files go through LibreOffice first.
    const rendered = path.toLowerCase().endsWith(".pdf")
      ? await this.execute(vm, { command: `mkdir -p "$OUT" && echo "$SRC"`, env: { OUT: outDir, SRC: path }, timeoutMs: 10_000 })
      : await this.execute(vm, {
          command: `mkdir -p "$OUT" && timeout 120 soffice --headless --norestore --convert-to pdf --outdir "$OUT" "$SRC" >/dev/null 2>&1; ls "$OUT"/*.pdf 2>/dev/null | head -1`,
          env: { OUT: outDir, SRC: path, HOME: "/tmp/computer-preview", PATH: GUEST_PATH },
          timeoutMs: 150_000,
        })
    const pdfPath = rendered.stdout?.trim()
    if (!pdfPath) return
    // One image per page (at most 60), 1600px on the long side: the panel lays them out like a deck.
    const paged = await this.execute(vm, {
      command: `pdftoppm -png -l ${MAX_PREVIEW_PAGES} -scale-to 1600 "$PDF" "$OUT/page" && ls "$OUT"/page-*.png | sort -V`,
      env: { OUT: outDir, PDF: pdfPath, PATH: GUEST_PATH },
      timeoutMs: 120_000,
    })
    const pagePaths = (paged.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
    const pages: Array<Uint8Array<ArrayBuffer>> = []
    for (const pagePath of pagePaths) pages.push(new Uint8Array(await this.blocks.files.read(vm, pagePath, { timeoutMs: 30_000 })))
    const size = pngSize(pages[0])
    const current = this.files.list(sessionId).find((file) => file.id === fileId)?.updatedAt
    if (size && current === version) await this.files.putPreview(sessionId, fileId, pages, size)
    await this.execute(vm, { command: `rm -rf "$OUT"`, env: { OUT: outDir }, timeoutMs: 10_000 }).catch(() => undefined)
  }

  async bash(sessionId: string, command: string, timeoutSeconds: number): Promise<ToolResult> {
    const copied = await this.copyUploads(sessionId)
    let result
    try { result = await this.exec(sessionId, command, timeoutSeconds) }
    catch (error) {
      if (!isSandboxError(error) || error.code !== "timeout") throw error
      return { output: `[No confirmed result after ${timeoutSeconds}s. The command may still be running; do not repeat side effects. Use background for long jobs.]`, isError: true }
    }
    const { saved, skipped } = await this.exportOutputs(sessionId).catch(() => ({ saved: [], skipped: [] }))
    const parts = [
      copied.length ? `[Copied the person's files to: ${copied.join(", ")}]` : "",
      `[exit ${result.exitCode}]`,
      tail(result.stdout ?? ""),
      result.stderr?.trim() ? `[stderr]\n${tail(result.stderr)}` : "",
      saved.length ? `[Added to their Files: ${saved.join(", ")}]` : "",
      skipped.length ? `[Not added to their Files: ${skipped.join("; ")}. Make it smaller, or tell them it is too big to hand over.]` : "",
    ]
    return { output: parts.filter(Boolean).join("\n"), isError: result.exitCode !== 0 }
  }

  async look(sessionId: string, paths: string[]): Promise<ToolResult> {
    await this.copyUploads(sessionId)
    const vm = await this.vm(sessionId)
    const counts = { images: 0, documents: 0 }
    const texts: string[] = []
    const result: ToolResult = { output: "", isError: false, images: [], documents: [] }
    for (const raw of paths) {
      const path = posix.resolve(WORKSPACE, raw)
      const stat = await this.blocks.files.stat(vm, path, { timeoutMs: 10_000 })
      if (!stat || stat.kind !== "file") {
        texts.push(`[${path}: no such file]`)
        result.isError = paths.length === 1
        continue
      }
      if (stat.size > MAX_LOOK_BYTES) {
        texts.push(`[${path} is ${formatBytes(stat.size)}, too large to look at. Make a smaller version with bash first.]`)
        continue
      }
      const bytes = await this.blocks.files.read(vm, path, { timeoutMs: 30_000 })
      const name = posix.basename(path)
      const reading = await this.readFile({ name, bytes }, counts)
      const unreadable = !reading.image && !reading.document && reading.text.startsWith("[Can't open")
      texts.push(
        unreadable
          ? `[${path} (${formatBytes(stat.size)}) can't be shown directly. Convert it with bash first, for example frames from a video: ffmpeg -i "${path}" -vf fps=1/2,scale=1280:-2 ${WORKSPACE}/frames/%03d.png, then look at a few of them.]`
          : `${path}\n${reading.text}`,
      )
      if (reading.image) result.images?.push(reading.image)
      if (reading.document) result.documents?.push(reading.document)
    }
    result.output = texts.join("\n\n")
    if (!result.images?.length) delete result.images
    if (!result.documents?.length) delete result.documents
    return result
  }
}

/** Width and height from a PNG's header. */
function pngSize(bytes: Uint8Array | undefined) {
  if (!bytes || bytes.byteLength < 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** The file store's "doesn't fit" error (a per-file or per-conversation limit); its message is for the model. */
function isLimitError(error: unknown): error is Error {
  return error instanceof Error && "code" in error && (error.code === "file_too_large" || error.code === "files_full")
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(1))} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

function tail(text: string) {
  const trimmed = text.trimEnd()
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…[${trimmed.length - OUTPUT_TAIL_CHARS} earlier characters cut]\n${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export const COMPUTER_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "look"])

export const COMPUTER_TOOLS: ToolSpec[] = [
  {
    name: "bash",
    description: [
      "Run a shell command on your Linux computer for this conversation (Ubuntu, internet access, sudo).",
      `The working directory is ${WORKSPACE}; everything there persists between messages.`,
      `Files the person sends are copied to ${FILES_DIR}. Anything you write to ${OUT_DIR} is added to their Files after the command.`,
      "Installed: python3 (pandas, numpy, matplotlib, openpyxl, xlsxwriter, python-docx, python-pptx, pdfplumber, pypdf, pillow, opencv), ffmpeg, imagemagick, poppler-utils, qpdf, tesseract, pandoc, node, jq, ripgrep, sqlite3, git, curl. Install more with sudo apt-get or pip.",
      `A command times out after timeout_seconds (at most ${MAX_COMMAND_SECONDS}). For longer work run \`background <name> '<command>'\` and check \`tail -n 20 ${WORKSPACE}/.jobs/<name>.log\`.`,
      "Always set description first: it is the progress update the person sees.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "The update the person sees while this runs: what you are doing for them, in a few plain words, with no commands, file paths or tool names. For example \"Pulling a few frames from your video\", \"Turning the recording into a GIF\", \"Adding up the totals in your spreadsheet\".",
        },
        command: { type: "string", description: "The command, run with bash -c." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_COMMAND_SECONDS },
      },
      required: ["description", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "look",
    description:
      "Look at files on your computer: images and PDFs as they are, Word, Excel and PowerPoint as text, text files as text. Pass up to 4 paths at once. To see a video, extract frames with ffmpeg first and look at those.",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 } },
      required: ["paths"],
      additionalProperties: false,
    },
  },
]

export const COMPUTER_PROMPT = `- You have a Linux computer for this conversation (the bash and look tools). Use it whenever a task needs real programs: video, audio, images, spreadsheets, charts, PDFs, data, code. Files the person sends are in ${FILES_DIR}; put files you make for them in ${OUT_DIR} and they appear in their Files. Look at your results before describing them. Don't mention paths, commands or the computer unless it helps them.`

const bashInput = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout_seconds: z.number().int().min(1).max(MAX_COMMAND_SECONDS).optional(),
})
const lookInput = z.object({ paths: z.array(z.string().min(1)).min(1).max(4) })

async function runComputerTool(computers: Computers, sessionId: string, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (name === "bash") {
    const parsed = bashInput.safeParse(input)
    if (!parsed.success) return { output: "bash needs a command (and optionally timeout_seconds up to 300).", isError: true }
    return computers.bash(sessionId, parsed.data.command, parsed.data.timeout_seconds ?? DEFAULT_COMMAND_SECONDS)
  }
  if (name === "look") {
    const parsed = lookInput.safeParse(input)
    if (!parsed.success) return { output: "look needs paths: 1 to 4 file paths.", isError: true }
    return computers.look(sessionId, parsed.data.paths)
  }
  return { output: `Unknown tool: ${name}`, isError: true }
}
