/**
 * Commands that outlive the request waiting for them (`awaitCommand` in computer.ts).
 * Run with `tsx --test src/computer-commands.test.ts`.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { SandboxError } from "@openwork/sandbox"
import { createFakeProvider } from "@openwork/sandbox/testing"
import { Computers } from "./computer.js"
import type { ComputerFile, ComputerFiles } from "./types.js"

type Job = { status: "running" | "done" | "lost"; exitCode: number; stopped?: boolean; stdout: string; stderr: string; starts: number }
const MARKER = "---computer-command---"

/**
 * A computer that keeps commands the way the real one does: a request names a command's files, starts the command
 * only when it carries the start and the computer has none under that name, and answers how the command stands.
 */
function fixture() {
  const jobs = new Map<string, Job>()
  const requests: Array<{ job: string; starts: boolean; waitSeconds: number }> = []
  const added: string[] = []
  const state = {
    /** What the next command started does. */
    next: { status: "done", exitCode: 0, stdout: "", stderr: "" } as Omit<Job, "starts">,
    /** How many of the next requests for a command lose their answer, after the computer acted on them. */
    cut: 0,
    /** Files in /workspace/out, as the outputs listing prints them. */
    outputs: "",
    /** The page images a preview render lists. */
    pages: "",
  }
  const provider = createFakeProvider({ onRun(spec) {
    const script = spec.env?.WORKBOT_COMMAND
    const job = script ? /^job='\/workspace\/\.jobs\/([^']+)'/.exec(script)?.[1] : undefined
    if (!script || !job) {
      if (spec.command.includes("pdftoppm")) return { exitCode: 0, stdout: state.pages, stderr: "" }
      if (spec.command.includes('echo "$SRC"')) return { exitCode: 0, stdout: spec.env?.SRC ?? "", stderr: "" }
      return { exitCode: 0, stdout: spec.command.includes("/workspace/out") ? `${state.outputs}---computer-exported---\n{}` : "0", stderr: "" }
    }
    const starts = script.includes("setsid nohup")
    requests.push({ job, starts, waitSeconds: Number(/end=\$\(\(SECONDS \+ (\d+)\)\)/.exec(script)?.[1]) })
    const known = jobs.get(job)
    if (starts && known) known.starts += 1
    if (starts && !known) jobs.set(job, { ...state.next, starts: 1 })
    if (state.cut > 0) {
      state.cut -= 1
      throw new SandboxError({ providerId: "fake", code: "timeout", retryable: false, message: "Operation exceeded its deadline; outcome may be unknown" })
    }
    const found = jobs.get(job)
    if (!found) return { exitCode: 0, stdout: `${MARKER} unknown 0 0 0 0\n`, stderr: "" }
    return { exitCode: 0, stdout: `${MARKER} ${found.status} ${found.exitCode} ${found.stopped ? 1 : 0} ${found.stdout.length} ${found.stderr.length}\n${found.stdout}`, stderr: found.stderr }
  } })
  const files: ComputerFiles = {
    maxFileBytes: 1_000_000,
    list: () => [],
    read: async (_sessionId, id) => ({ file: { id, name: "deck.pdf", size: 3, source: "agent", updatedAt: 1 }, bytes: new TextEncoder().encode("pdf") }),
    add: async (_sessionId, input) => {
      added.push(input.name)
      const file: ComputerFile = { id: `file-${added.length}`, name: input.name, size: input.bytes.byteLength, source: "agent", updatedAt: 1 }
      return file
    },
    replace: async () => null,
    putPreview: async () => true,
  }
  /** One runner process; several over the same provider stand in for one that stopped and the one that took over. */
  const process = () => new Computers({ provider, idlePauseMs: 60_000, keepDays: 1 }, { files, readFile: async () => ({ text: "" }) })
  return { provider, jobs, requests, added, state, process, started: () => [...jobs.values()].reduce((total, job) => total + job.starts, 0) }
}

test("a command's result reads as it always has, and its outputs go to the person's Files", async () => {
  const f = fixture()
  const computers = f.process()
  f.state.next = { status: "done", exitCode: 2, stdout: "built 3 pages\n", stderr: "warning: font missing\n" }
  const failed = await computers.run("session", "bash", { command: "make report" }, "call-1")
  assert.deepEqual(failed, { output: "[exit 2]\nbuilt 3 pages\n[stderr]\nwarning: font missing", isError: true })

  const box = await computers.vm("session")
  await f.provider.blocks?.files?.write(box, "/workspace/out/report.csv", new TextEncoder().encode("a,b"), { timeoutMs: 1000 })
  f.state.outputs = "report.csv\t3\t1.0\n"
  f.state.next = { status: "done", exitCode: 0, stdout: "x".repeat(40_000), stderr: "" }
  const long = await computers.run("session", "bash", { command: "make report" }, "call-2")
  assert.equal(long.output, `[exit 0]\n…[10000 earlier characters cut]\n${"x".repeat(30_000)}\n[Added to their Files: report.csv]`)
  assert.equal(long.isError, false)
  // Each command waits a little longer than its own limit, in one request.
  assert.deepEqual(f.requests.map((request) => [request.starts, request.waitSeconds]), [[true, 130], [true, 130]])
})

test("a command whose wait is cut is picked up with its real exit code and output, and is never started again", async () => {
  const f = fixture()
  f.state.next = { status: "done", exitCode: 3, stdout: "half the rows failed\n", stderr: "" }
  // The request that started it never answers; the same call waits again, without the start.
  f.state.cut = 1
  const result = await f.process().run("session", "bash", { command: "import rows", timeout_seconds: 30 }, "call-1")
  assert.deepEqual(result, { output: "[exit 3]\nhalf the rows failed", isError: true })
  // The second wait is for what is left of the command's time: all of it here, as the first was cut at once.
  assert.deepEqual(f.requests.map((request) => [request.starts, request.waitSeconds]), [[true, 40], [false, 40]])

  // The runner that was waiting is gone. The one that takes over asks for the call, and gets its outputs handed over.
  f.state.next = { status: "running", exitCode: 0, stdout: "", stderr: "" }
  f.state.cut = 2
  const lost = await f.process().run("session", "bash", { command: "render video", timeout_seconds: 30 }, "call-2")
  assert.match(lost.output, /^\[No confirmed result after 30s\. The command may still be running/)
  const job = f.jobs.get(f.requests.at(-1)?.job ?? "")
  assert.ok(job)
  Object.assign(job, { status: "done", exitCode: 0, stdout: "rendered\n" })
  const next = f.process()
  const box = await next.vm("session")
  await f.provider.blocks?.files?.write(box, "/workspace/out/video.mp4", new TextEncoder().encode("mp4"), { timeoutMs: 1000 })
  f.state.outputs = "video.mp4\t3\t1.0\n"
  const picked = await next.pickUp("session", "bash", { command: "render video", timeout_seconds: 30 }, "call-2")
  assert.deepEqual(picked, { output: "[exit 0]\nrendered\n[Added to their Files: video.mp4]", isError: false })
  assert.deepEqual(f.added, ["video.mp4"])

  assert.equal(f.started(), 2, "each command was started once")
  assert.equal(f.requests.filter((request) => request.starts).length, 2, "picking a command up never asks to start it")
})

test("a command still running when it is picked up says so, and how to check on it", async () => {
  const f = fixture()
  f.state.next = { status: "running", exitCode: 0, stdout: "frame 12 of 900\n", stderr: "" }
  f.state.cut = 2
  await f.process().run("session", "bash", { command: "render", timeout_seconds: 300 }, "call-1")
  f.requests.length = 0
  const result = await f.process().pickUp("session", "bash", { command: "render", timeout_seconds: 300 }, "call-1")
  const job = [...f.jobs.keys()][0]
  assert.equal(result?.isError, true)
  assert.equal(result?.output, `[Still running: it did not stop at its 300s limit. Its output so far is in /workspace/.jobs/${job}.out and ${job}.err, and /workspace/.jobs/${job}.exit will hold its exit code once it ends. Check on it there; do not repeat side effects.]\nframe 12 of 900`)
  // It waited as long as the command could take to stop, in requests short enough for the provider.
  assert.deepEqual(f.requests.map((request) => [request.starts, request.waitSeconds]), [[false, 290], [false, 20]])
  assert.equal(f.started(), 1)
})

test("a command stopped at its time limit, or one whose process is gone, says what is known", async () => {
  const f = fixture()
  const computers = f.process()
  f.state.next = { status: "done", exitCode: 124, stopped: true, stdout: "step 1 done\n", stderr: "" }
  assert.deepEqual(await computers.run("session", "bash", { command: "slow", timeout_seconds: 5 }, "call-1"), {
    output: "[Stopped after 5s, its time limit, before it finished. Use background for long jobs.]\nstep 1 done",
    isError: true,
  })
  f.state.next = { status: "lost", exitCode: 0, stdout: "step 1 done\n", stderr: "" }
  const lost = await computers.run("session", "bash", { command: "slow" }, "call-2")
  assert.match(lost.output, /^\[The command's process ended without an exit code.*\]\nstep 1 done$/)
  assert.equal(lost.isError, true)
})

test("a call the computer never started has no result, and asking never starts a command or a computer", async () => {
  const f = fixture()
  assert.equal(await f.process().pickUp("session", "bash", { command: "send invoices" }, "call-1"), null)
  assert.equal(f.provider.fake.count("create"), 0, "no computer is made to ask")

  await f.process().run("session", "bash", { command: "echo ready" }, "call-0")
  f.requests.length = 0
  assert.equal(await f.process().pickUp("session", "bash", { command: "send invoices" }, "call-1"), null)
  assert.equal(await f.process().pickUp("session", "look", { paths: ["chart.png"] }, "call-0"), null)
  assert.deepEqual(f.requests.map((request) => request.starts), [false])
  assert.equal(f.started(), 1)
})

test("a preview render logs when it starts and when it ends, with ids and times only", async (t) => {
  const f = fixture()
  const computers = f.process()
  const lines: string[] = []
  t.mock.method(console, "log", (line: unknown) => void lines.push(String(line)))
  const box = await computers.vm("session")
  const page = new Uint8Array(24)
  new DataView(page.buffer).setUint32(16, 1600)
  new DataView(page.buffer).setUint32(20, 900)
  await f.provider.blocks?.files?.write(box, "/tmp/computer-preview/file-9/page-1.png", page, { timeoutMs: 1000 })
  f.state.pages = "/tmp/computer-preview/file-9/page-1.png\n"
  await computers.previewSavedFile("session", "file-9")
  const previews = lines.filter((line) => line.startsWith("[headless-computer] preview "))
  assert.equal(previews[0], '[headless-computer] preview started {"sessionId":"session","fileId":"file-9","floating":false}')
  assert.match(previews[1] ?? "", /^\[headless-computer\] preview finished \{"sessionId":"session","fileId":"file-9","floating":false,"outcome":"kept","pages":1,"ms":\d+\}$/)
  assert.equal(previews.length, 2)
})
