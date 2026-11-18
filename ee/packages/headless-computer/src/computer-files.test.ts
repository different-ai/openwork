/** How the person's files reach the computer and its outputs reach their Files (computer.ts): one command to see what is there, links for the bytes, the runner as the fallback. */
import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import type { RunResult, RunSpec, SandboxProvider } from "@openwork/sandbox"
import { createFakeProvider } from "@openwork/sandbox/testing"
import { Computers } from "./computer.js"
import type { ComputerFile, ComputerFiles } from "./types.js"

const SESSION = "conversation"
const encode = (text: string) => new Uint8Array(Buffer.from(text))

/** The conversation's kept files in memory. `carried` lists what went through the runner: `in:<id>` and `out:<name>`. */
function keptFiles(links?: Pick<ComputerFiles, "downloadUrl" | "receive">) {
  const rows: ComputerFile[] = []
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>()
  const carried: string[] = []
  const keep = (name: string, content: Uint8Array<ArrayBuffer>, source: ComputerFile["source"]) => {
    const file: ComputerFile = { id: `fl_${rows.length + 1}`, name, size: content.byteLength, source, updatedAt: rows.length + 1 }
    rows.unshift(file)
    bytes.set(file.id, content)
    return file
  }
  const files: ComputerFiles = {
    maxFileBytes: 1_000_000,
    list: () => [...rows],
    async read(_session, id) {
      carried.push(`in:${id}`)
      const file = rows.find((row) => row.id === id)
      const content = bytes.get(id)
      return file && content ? { file, bytes: content } : null
    },
    async add(_session, input) {
      carried.push(`out:${input.name}`)
      return keep(input.name, input.bytes, "agent")
    },
    async replace() {
      return null
    },
    async putPreview() {
      return false
    },
    ...links,
  }
  return { files, rows, bytes, carried, keep, sent: (name: string, text: string) => keep(name, encode(text), "user") }
}

/** A computer whose commands answer from `answer` (by the command's text), recording commands, file writes and provider calls. */
function scripted(files: ComputerFiles, answer: (command: string) => string | undefined, options: { desktop?: boolean } = {}) {
  const commands: string[] = []
  const written = new Map<string, { text: string; mode: number | undefined }>()
  const calls: string[] = []
  const fake = createFakeProvider({
    onOperation: (operation) => void calls.push(operation.name),
    onRun: (spec) => {
      commands.push(spec.command)
      return { exitCode: 0, stdout: answer(spec.command) ?? "", stderr: "" }
    },
  })
  const inner = fake.blocks?.files
  assert.ok(inner)
  const provider: SandboxProvider = {
    ...fake,
    blocks: {
      ...fake.blocks,
      files: {
        ...inner,
        async write(handle, path, content, opts) {
          written.set(path, { text: Buffer.from(content).toString(), mode: opts.mode })
          return inner.write(handle, path, content, opts)
        },
      },
    },
  }
  const computers = new Computers({ provider, idlePauseMs: 60_000, keepDays: 1, desktop: options.desktop }, { files, readFile: async () => ({ text: "file" }) })
  return { computers, commands, written, calls, provider }
}

const isSeeing = (command: string) => command.startsWith("find /workspace/files ")
const isListing = (command: string) => command.startsWith("find /workspace/out ")
const isTransfer = (command: string) => command.includes("curl ")
const SIGNATURE = "X-Amz-Signature=0123abcd"
const link = (id: string) => `https://store.example/files/${id}?${SIGNATURE}`

test("a new process sees what is on the computer in one command and copies nothing again", async () => {
  const kept = keptFiles({ downloadUrl: async (_session, id) => link(id) })
  kept.sent("report.pdf", "pdf")
  kept.sent("data.csv", "rows")
  const { computers, commands, calls, written } = scripted(kept.files, (command) =>
    isSeeing(command) ? `report.pdf\t3\ndata.csv\t4\nnotes of mine.txt\t9\n---computer-copied---\n{"fl_1":"report.pdf","fl_2":"data.csv"}\n` : undefined)
  const result = await computers.bash(SESSION, "true", 10)
  assert.equal(result.output, "[exit 0]")
  // One command to see the folder and the record, then the command itself and the look at its outputs.
  assert.equal(commands.length, 3)
  assert.deepEqual(calls.filter((name) => name.startsWith("files.")), [])
  assert.deepEqual(kept.carried, [])
  assert.equal(written.size, 0)
  // The same process doesn't look again.
  await computers.bash(SESSION, "true", 10)
  assert.equal(commands.filter(isSeeing).length, 1)
  await computers.delete(SESSION)
})

test("a replacement computer has the record but not the files: they are fetched again by link, in one command", async () => {
  for (const desktop of [false, true]) {
    const kept = keptFiles({ downloadUrl: async (_session, id) => link(id) })
    kept.sent("report.pdf", "pdf")
    kept.sent("it's data.csv", "rows")
    // The record was carried over; /workspace/files was not, and holds something else called report.pdf.
    const { computers, commands, written, calls } = scripted(kept.files, (command) =>
      isSeeing(command) ? `report.pdf\t999\n---computer-copied---\n{"fl_1":"report.pdf","fl_2":"it's data.csv"}\n` : isTransfer(command) ? "copied 0\ncopied 1\n" : undefined, { desktop })
    const result = await computers.look(SESSION, ["nothing.txt"])
    assert.match(result.output, /no such file/)

    const folder = desktop ? "/home/ubuntu" : "/workspace/.jobs"
    const [[planPath, plan] = ["", { text: "", mode: undefined }]] = [...written]
    assert.equal(written.size, 1)
    assert.match(planPath, new RegExp(`^${folder}/\\.openwork-transfer-[0-9a-f]{32}$`))
    // On a desktop that folder is the provider account's own; the command closes the file to others first.
    assert.equal(plan.mode, undefined)
    const part = (index: number) => new RegExp(`output = "(/workspace/files/\\.openwork-part-[0-9a-f]{32}-${index})"`).exec(plan.text)?.[1] ?? "missing"
    assert.ok(plan.text.includes(`url = "${link("fl_2")}"\noutput = "${part(0)}"\nfail\n`))
    assert.ok(plan.text.includes(`\nnext\nurl = "${link("fl_1")}"\noutput = "${part(1)}"\n`))

    // The links are in that file only: never in a command.
    assert.ok(commands.every((command) => !command.includes("store.example") && !command.includes("X-Amz")))
    const transfer = commands.find(isTransfer) ?? ""
    assert.ok(transfer.includes(`--config ${planPath} `))
    const permissions = desktop ? `chmod 660 ${part(0)} && ` : ""
    assert.ok(transfer.includes(`[ "$(stat -c %s ${part(0)} 2>/dev/null)" = 4 ] && ${permissions}mv -fT -- ${part(0)} '/workspace/files/it'"'"'s data.csv' && echo copied 0`))
    // The other report.pdf is not this one, so the person's file gets its own name; the record says so.
    assert.ok(transfer.includes(`mv -fT -- ${part(1)} '/workspace/files/report (2).pdf' && echo copied 1`))
    assert.ok(transfer.includes(`printf %s '{"fl_1":"report (2).pdf","fl_2":"it'"'"'s data.csv"}' > /workspace/.jobs/.copied.json`))
    assert.ok(transfer.startsWith(`trap 'rm -rf ${planPath} ${planPath}.d ${part(0)} ${part(1)}' EXIT\nchmod 600 ${planPath}\n`))
    assert.equal(commands.length, 2)
    assert.deepEqual(kept.carried, [])
    assert.deepEqual(calls.filter((name) => name === "files.write" || name === "files.read"), ["files.write"])
    await computers.delete(SESSION)
  }
})

test("when nothing arrives by link, files go through the runner, and links rest for a while", async (t) => {
  const warned = t.mock.method(console, "warn", () => undefined)
  const kept = keptFiles({ downloadUrl: async (_session, id) => link(id) })
  kept.sent("report.pdf", "pdf")
  const { computers, commands, written, provider } = scripted(kept.files, (command) => (isSeeing(command) ? `---computer-copied---\n{}\n` : undefined))
  const first = await computers.bash(SESSION, "true", 10)
  assert.equal(first.output, "[Copied the person's files to: /workspace/files/report.pdf]\n[exit 0]")
  assert.deepEqual(kept.carried, ["in:fl_1"])
  assert.equal(written.get("/workspace/files/report.pdf")?.text, "pdf")
  assert.equal(written.get("/workspace/.jobs/.copied.json")?.text, `{"fl_1":"report.pdf"}`)
  assert.equal(commands.filter(isTransfer).length, 1)
  // Said once, without the link.
  assert.equal(warned.mock.callCount(), 1)
  assert.ok(!JSON.stringify(warned.mock.calls[0]?.arguments).includes("store.example"))

  // The next file doesn't try a link again so soon.
  kept.sent("more.csv", "rows")
  const second = await computers.bash(SESSION, "true", 10)
  assert.match(second.output, /^\[Copied the person's files to: \/workspace\/files\/more\.csv\]/)
  assert.deepEqual(kept.carried, ["in:fl_1", "in:fl_2"])
  assert.equal(commands.filter(isTransfer).length, 1)
  assert.equal(Buffer.from(await provider.blocks?.files?.read(await computers.vm(SESSION), "/workspace/files/more.csv", { timeoutMs: 1_000 }) ?? []).toString(), "rows")
  await computers.delete(SESSION)
})

test("changed outputs are sent by link in one command; the store decides what is kept", async () => {
  const asked: Array<{ name: string; size: number; replaces: string | undefined }> = []
  const kept = keptFiles({
    async receive(_session, input) {
      asked.push({ name: input.name, size: input.size, replaces: input.replaces })
      if (input.name === "full.bin") throw Object.assign(new Error("This conversation's files are full."), { code: "files_full" })
      return {
        url: link(`incoming-${asked.length}`),
        // The chart arrived; the report didn't; the grown file turned out larger than the limit once measured.
        finish: async () => {
          if (input.name === "grown.bin") throw Object.assign(new Error("That file is too large."), { code: "file_too_large" })
          return input.name === "chart.png" ? kept.keep("chart.png", encode("12345"), "agent") : null
        },
      }
    },
  })
  const listing = [`chart.png\t5\t1.5`, `huge.bin\t2000000\t1.5`, `full.bin\t9\t1.5`, `grown.bin\t9\t1.5`, `drafts/it's "final".pdf\t7\t2.5`, `same.txt\t3\t7.5`].join("\n")
  const { computers, commands, written, provider } = scripted(kept.files, (command) =>
    isListing(command) ? `${listing}\n---computer-exported---\n{"same.txt":"3:7.5|fl_old","chart.png":"4:1.0|fl_before"}\n` : undefined)
  await provider.blocks?.files?.write(await computers.vm(SESSION), `/workspace/out/drafts/it's "final".pdf`, encode("report!"), { timeoutMs: 1_000 })
  written.clear()

  const result = await computers.bash(SESSION, "make things", 10)
  assert.equal(result.output, [
    "[exit 0]",
    `[Added to their Files: chart.png, it's "final".pdf]`,
    "[Not added to their Files: huge.bin (1.9 MB; the most a kept file can be is 977 KB); full.bin (This conversation's files are full.); grown.bin (That file is too large.). Make it smaller, or tell them it is too big to hand over.]",
  ].join("\n"))
  // Asked for what changed and could fit; the chart is a new version of the file it was before.
  assert.deepEqual(asked, [
    { name: "chart.png", size: 5, replaces: "fl_before" },
    { name: "full.bin", size: 9, replaces: undefined },
    { name: "grown.bin", size: 9, replaces: undefined },
    { name: `it's "final".pdf`, size: 7, replaces: undefined },
  ])
  // Only what didn't arrive went through the runner.
  assert.deepEqual(kept.carried, [`out:it's "final".pdf`])

  const planPath = [...written.keys()].find((path) => path.includes(".openwork-transfer-")) ?? ""
  const links = `${planPath}.d`
  assert.equal(written.get(planPath)?.text.split("\nnext\n").length, 3)
  assert.ok(written.get(planPath)?.text.includes(`url = "${link("incoming-1")}"\nupload-file = "${links}/0"\nfail\ngloboff\n`))
  const transfer = commands.find(isTransfer) ?? ""
  assert.ok(transfer.includes(`umask 077\nmkdir ${links} || exit 1\nln -s -- '/workspace/out/chart.png' ${links}/0\nln -s -- '/workspace/out/grown.bin' ${links}/1\nln -s -- '/workspace/out/drafts/it'"'"'s "final".pdf' ${links}/2\n`))
  assert.ok(commands.every((command) => !command.includes("store.example") && !command.includes("X-Amz")))
  assert.equal(commands.filter(isTransfer).length, 1)

  // Each version is recorded with what it became, so none is looked at again.
  assert.deepEqual(JSON.parse(written.get("/workspace/.jobs/.exported.json")?.text ?? "{}"), {
    "same.txt": "3:7.5|fl_old",
    "chart.png": "5:1.5|fl_1",
    "huge.bin": "2000000:1.5|",
    "full.bin": "9:1.5|",
    "grown.bin": "9:1.5|",
    [`drafts/it's "final".pdf`]: "7:2.5|fl_2",
  })
  await computers.delete(SESSION)
})

/** The computer's own tools: GNU stat, find and mv, and curl. Without them the last test has nothing to run. */
function hasComputerTools() {
  try {
    execFileSync("sh", ["-c", "stat -c %s / && find / -maxdepth 0 -printf x && mv --version && curl --version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

test("on a real shell with curl: files arrive whole, with their permissions and record, and outputs reach the store", { skip: hasComputerTools() ? false : "needs GNU stat, find and mv, and curl (run it on Linux)" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "computer-files-"))
  const local = (text: string) => text.replaceAll("/workspace", `${root}/workspace`).replaceAll("/home/ubuntu", `${root}/home/ubuntu`)
  for (const folder of ["workspace/files", "workspace/out", "workspace/.jobs", "home/ubuntu"]) mkdirSync(join(root, folder), { recursive: true })

  // The store: hands out links to this server, and keeps what is sent to them. `refused` answers 403.
  const stored = new Map<string, Buffer>()
  const refused = new Set<string>()
  const requests: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://store")
    const key = decodeURIComponent(url.pathname.slice(1))
    requests.push(`${request.method} ${key}`)
    if (!url.searchParams.has("X-Amz-Signature") || refused.has(key)) return void response.writeHead(403).end("<Error/>")
    if (request.method === "GET") return void (stored.has(key) ? response.writeHead(200).end(stored.get(key)) : response.writeHead(404).end())
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => {
      stored.set(key, Buffer.concat(chunks))
      response.writeHead(200).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  const linkTo = (key: string) => `http://127.0.0.1:${address.port}/${encodeURIComponent(key)}?X-Amz-Signature=abc&X-Amz-Expires=120`

  let incoming = 0
  const kept = keptFiles({
    downloadUrl: async (_session, id) => linkTo(id),
    async receive(_session, input) {
      const key = `incoming-${++incoming}`
      return { url: linkTo(key), finish: async () => (stored.has(key) ? kept.keep(input.name, new Uint8Array(stored.get(key) ?? []), "agent") : null) }
    },
  })

  // A computer on this machine: its files under `root`, its commands in a real shell. Commands of a desktop go
  // through its helper, which here just runs them.
  const run = (spec: RunSpec) => new Promise<RunResult>((resolve) => {
    const bridged = / \| sudo -n \/usr\/local\/sbin\/openwork-desktop-bridge command$/.exec(spec.command)
    const command = bridged
      ? `umask 007; cd ${root}/workspace; exec bash -c "$(${local(spec.command.slice(0, bridged.index))} | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).command)')"`
      : local(spec.command)
    execFile("sh", ["-c", command], { env: { ...process.env, ...spec.env }, encoding: "utf8" }, (error, stdout, stderr) =>
      resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }))
  })
  const fake = createFakeProvider()
  const provider: SandboxProvider = {
    ...fake,
    blocks: {
      ...fake.blocks,
      run: (_handle, spec) => run(spec),
      files: {
        async read(_handle, path) { return new Uint8Array(readFileSync(local(path))) },
        async write(_handle, path, content, opts) {
          mkdirSync(dirname(local(path)), { recursive: true })
          writeFileSync(local(path), path.includes(".openwork-transfer-") ? local(Buffer.from(content).toString()) : content)
          if (opts.mode !== undefined) chmodSync(local(path), opts.mode)
        },
        async stat(_handle, path) { return existsSync(local(path)) ? { size: statSync(local(path)).size, kind: "file" } : null },
      },
    },
  }

  try {
    const computers = new Computers({ provider, idlePauseMs: 60_000, keepDays: 1, desktop: true }, { files: kept.files, readFile: async () => ({ text: "file" }) })
    const report = kept.sent("report.pdf", "%PDF the report")
    const odd = kept.sent(`it's a "quoted" $HOME {name}.txt`, "odd name, plain content")
    const big = kept.keep("clip.bin", new Uint8Array(3 * 1024 * 1024).fill(7), "user")
    for (const file of [report, odd, big]) stored.set(file.id, Buffer.from(kept.bytes.get(file.id) ?? []))

    const first = await computers.bash(SESSION, `cp files/report.pdf "out/copy of report.pdf" && mkdir -p out/charts && printf 'a chart' > "out/charts/q3's [final] {chart}.png" && ls files | wc -l`, 30)
    assert.equal(first.isError, false)
    assert.match(first.output, /^\[Copied the person's files to: \/workspace\/files\/clip\.bin, \/workspace\/files\/it's a "quoted" \$HOME \{name\}\.txt, \/workspace\/files\/report\.pdf\]\n\[exit 0\]\n3\n/)
    assert.match(first.output, /\[Added to their Files: (copy of report\.pdf, q3's \[final\] \{chart\}\.png|q3's \[final\] \{chart\}\.png, copy of report\.pdf)\]$/)

    // The person's files: whole, readable and writable by the desktop's shared group, and recorded.
    const filesDir = join(root, "workspace/files")
    assert.deepEqual(readdirSync(filesDir).sort(), ["clip.bin", `it's a "quoted" $HOME {name}.txt`, "report.pdf"])
    assert.equal(readFileSync(join(filesDir, "report.pdf"), "utf8"), "%PDF the report")
    assert.equal(readFileSync(join(filesDir, odd.name), "utf8"), "odd name, plain content")
    assert.ok(readFileSync(join(filesDir, "clip.bin")).equals(Buffer.from(kept.bytes.get(big.id) ?? [])))
    for (const name of readdirSync(filesDir)) assert.equal(statSync(join(filesDir, name)).mode & 0o777, 0o660, name)
    assert.deepEqual(JSON.parse(readFileSync(join(root, "workspace/.jobs/.copied.json"), "utf8")), { [report.id]: "report.pdf", [odd.id]: odd.name, [big.id]: "clip.bin" })

    // The outputs: sent by the computer itself, kept from what the store received.
    assert.deepEqual(kept.rows.filter((file) => file.source === "agent").map((file) => [file.name, Buffer.from(kept.bytes.get(file.id) ?? []).toString()]).sort(), [
      ["copy of report.pdf", "%PDF the report"],
      ["q3's [final] {chart}.png", "a chart"],
    ])
    // Nothing went through the runner, and nothing with a link in it is left on the computer.
    assert.deepEqual(kept.carried, [])
    assert.deepEqual(readdirSync(join(root, "home/ubuntu")), [])
    assert.deepEqual(requests.filter((request) => request.startsWith("GET")).sort(), [`GET ${big.id}`, `GET ${odd.id}`, `GET ${report.id}`].sort())
    assert.equal(requests.filter((request) => request.startsWith("PUT")).length, 2)

    // A store that refuses one file: that one goes through the runner, the others still by link.
    const later = kept.sent("later.txt", "sent later")
    const refusedFile = kept.sent("refused.txt", "the store said no")
    stored.set(later.id, Buffer.from("sent later"))
    refused.add(refusedFile.id)
    const second = await computers.bash(SESSION, "cat files/later.txt files/refused.txt", 30)
    assert.match(second.output, /\[exit 0\]\nsent laterthe store said no$/)
    assert.deepEqual(kept.carried, [`in:${refusedFile.id}`])
    assert.equal(statSync(join(filesDir, "refused.txt")).mode & 0o777, 0o660)
    assert.deepEqual(readdirSync(filesDir).filter((name) => name.startsWith(".")), [])
    assert.deepEqual(readdirSync(join(root, "home/ubuntu")), [])
    await computers.delete(SESSION)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
