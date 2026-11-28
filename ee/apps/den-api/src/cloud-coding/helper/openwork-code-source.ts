export const OPENWORK_CODE_HELPER_SOURCE = String.raw`import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const cleanupMessage = 'Removed the working folder and its credential from this computer.'
const rootRefusal = 'Choose a private working folder for this task. Do not use the filesystem root, your home directory, or an existing repository or its parent.'
const maxWaitMs = 280_000
const pollDeadlineReached = Symbol()
const prefix = '/v1/cloud-coding/gateway'
const script = JSON.stringify(process.argv[1])
const secrets = new Set()
const taskIdPattern = /^[A-Za-z0-9_-]{1,100}$/
const shaPattern = /^[0-9a-f]{40}$/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tooLarge = 'This change is too large to push at once. Split it into smaller changes.'
const usage = {
  setup: ['--api <url> --code <code> --root <dir>', 'setup --api https://den.example --code "$SETUP_CODE" --root ./coding-task'],
  detect: ['(--root <dir> | --dir <path>) [--json]', 'detect --root ./coding-task --json'],
  'request-push': ['--root <dir> --branch <name> --title <title> --tests <passed|failed|not_run> [--test-command <cmd>] [--test-summary <text>] [--message <text> | --message-file <path>] [--body <text> | --body-file <path>] [--wait-seconds <n>]', 'request-push --root ./coding-task --branch openwork/fix-rounding --title "Fix checkout rounding" --tests passed --test-command "pnpm test" --body-file ./coding-task/pull-request.md'],
  wait: ['--root <dir> [--wait-seconds <n>]', 'wait --root ./coding-task'],
  status: ['--root <dir> [--json]', 'status --root ./coding-task --json'],
  finish: ['--root <dir>', 'finish --root ./coding-task'],
}

class Refusal extends Error {
  constructor(message, exitCode = 1, gatewayCode) {
    super(message)
    this.exitCode = exitCode
    this.gatewayCode = gatewayCode
  }
}

function fail(message, exitCode) { throw new Refusal(message, exitCode) }
function redact(value) {
  let text = value
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
  return text
}
function line(value) { console.log(redact(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')) }
function json(value) { console.log(JSON.stringify(value, (_key, entry) => typeof entry === 'string' ? redact(entry) : entry)) }
function help(command) {
  for (const name of command ? [command] : Object.keys(usage)) {
    const [options, example] = usage[name]
    line('Usage: node ' + script + ' ' + name + ' ' + options)
    line('Example: node ' + script + ' ' + example)
  }
  if (!command || command === 'wait' || command === 'request-push') line('The default approval wait is 240 seconds (maximum 280). Use --wait-seconds 0 to return immediately if still pending.')
}
function optionsFor(command, args) {
  const options = Object.create(null)
  const allowed = new Set(usage[command][0].match(/--[a-z-]+/g))
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!allowed.has(key) || key in options) fail('An option is unknown or repeated. Run ' + command + ' --help to see the options.')
    if (key === '--json') options[key] = true
    else if (i + 1 === args.length || allowed.has(args[i + 1])) fail('An option is missing its value. Run ' + command + ' --help to see the options.')
    else options[key] = args[++i]
  }
  return options
}
function required(options, key, max) {
  const value = options[key]
  if (!value?.trim() || value.length > max) fail('Provide ' + key + ' with a value of at most ' + max + ' characters. See --help for an example.')
  return value
}
function optionalText(options, key, max) {
  const file = options[key + '-file']
  if (file !== undefined && options[key] !== undefined) fail('Use either ' + key + ' or ' + key + '-file, not both.')
  let value = options[key]
  if (file !== undefined) {
    try { value = fs.readFileSync(file, 'utf8') } catch { fail('Could not read ' + key + '-file. Check the file path and try again.') }
  }
  if (value !== undefined && value.length > max) fail(key + ' is too long. Use at most ' + max + ' characters.')
  return value
}
function waitMs(options) {
  const value = options['--wait-seconds'] ?? '240'
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) fail('Provide a non-negative number for --wait-seconds, or leave it out to use the default.')
  const testCap = Number(process.env.OPENWORK_CODE_TEST_MAX_WAIT_MS)
  const cap = Number.isSafeInteger(testCap) && testCap > 0 ? Math.min(maxWaitMs, testCap) : maxWaitMs
  return Math.min(Math.round(Number(value) * 1000), cap)
}

function loopback(url) { return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) }
function apiUrl(input) {
  let url
  try { url = new URL(input) } catch { fail('Den’s address is not a URL. Ask for a new setup command.') }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url))) || url.username || url.password || url.search || url.hash) fail('Use Den’s HTTPS address without credentials, a query, or a fragment.')
  return url.href.replace(/\/+$/, '')
}
function credentialEnded(state, message) {
  if (message) line(message)
  fail('The credential for this task has ended. Call cloud-coding:start again with taskId ' + state.taskId + ' and run the new setup command.', 6)
}
function requireCredential(state) {
  if (!state.token) credentialEnded(state)
}
async function gateway(state, endpoint, { method = 'GET', body, pollMs, deadline, retryPost = false } = {}) {
  if (endpoint !== '/setup') requireCredential(state)
  const headers = { Accept: 'application/json' }
  if (state.token) headers.Authorization = 'Bearer ' + state.token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const payload = body === undefined ? undefined : JSON.stringify(body)
  for (let attempt = 0; ; attempt++) {
    let response
    let text
    const remaining = deadline === undefined ? Infinity : deadline - Date.now()
    if (remaining <= 0) throw pollDeadlineReached
    try {
      response = await fetch(state.api + prefix + endpoint, {
        method, headers, body: payload, redirect: 'error',
        signal: AbortSignal.timeout(Math.min(remaining, pollMs === undefined ? 30000 : pollMs + 10000)),
      })
      text = await response.text()
    } catch {
      if (deadline !== undefined && Date.now() >= deadline) throw pollDeadlineReached
      if (attempt < 3 && (method === 'GET' || retryPost)) {
        await sleep(Math.min(deadline === undefined ? Infinity : Math.max(0, deadline - Date.now()), 250 * 2 ** attempt))
        continue
      }
      const hint = method === 'GET' || retryPost ? 'Check the connection to Den and run the command again.' : 'Check the connection to Den and confirm the last step in OpenWork before trying again.'
      fail('Could not reach the cloud coding gateway. ' + hint)
    }
    if (retryPost && attempt < 3 && [502, 503, 504].includes(response.status)) { await sleep(250 * 2 ** attempt); continue }
    let result
    try { result = JSON.parse(text) } catch { fail('Den did not return a cloud coding response. Check Den’s address and try again.') }
    if (!response.ok) {
      const message = typeof result?.message === 'string' && result.message.trim() ? result.message : 'Den refused the request. Check the task in OpenWork and try again.'
      if (response.status === 401 && result?.error === 'task_closed' && state.taskId) credentialEnded(state, message)
      throw new Refusal(message, 1, result?.error)
    }
    return result
  }
}

function contains(root, location) {
  const relative = path.relative(root, location)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
function protectRoot(root, checkout) {
  const home = path.resolve(homedir())
  if (root === path.parse(root).root || contains(root, home) || contains(root, fs.existsSync(home) ? fs.realpathSync(home) : home)) fail(rootRefusal)
  if (fs.realpathSync(root) !== root || fs.existsSync(path.join(root, '.git'))) fail(rootRefusal)
  for (let dir = fs.realpathSync(process.cwd()); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      if (contains(root, dir) && dir !== checkout) fail(rootRefusal)
      break
    }
    if (dir === path.dirname(dir)) break
  }
}
function workingRoot(options, create = false) {
  const root = path.resolve(required(options, '--root', 4000))
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(root, { throwIfNoEntry: false })
  if (!stat) fail('This task is not set up here. Run setup with the code from OpenWork.')
  if (!stat.isDirectory()) fail('The working folder must be a directory, not a file or a symlink.')
  return fs.realpathSync(root)
}
function stateFile(root) { return path.join(root, 'state.json') }
function checkoutPath(root, repository) {
  const name = repository?.fullName?.split('/').at(-1)
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name) || ['.', '..', '.git', 'state.json', 'openwork-code.mjs', 'pull-request.md'].includes(name.toLowerCase())) fail('Den returned an invalid repository name. Ask for a new setup command.')
  return path.join(root, name)
}
function saveState(state) {
  const tmp = path.join(state.root, '.' + randomUUID())
  try {
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, stateFile(state.root))
  } finally { fs.rmSync(tmp, { force: true }) }
}
function loadState(root, optional = false) {
  const file = stateFile(root)
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!stat && optional) return null
  if (!stat) fail('This task is not set up here. Run setup with the code from OpenWork.')
  if (!stat.isFile()) fail('The task state is not a regular file. Restore it before trying again.')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (state.root !== root || typeof state.taskId !== 'string' || !taskIdPattern.test(state.taskId) || state.dir !== checkoutPath(root, state.repository)) fail('This is not a cloud coding working folder.')
  secrets.add(state.token)
  return state
}
async function cleanup(state) {
  protectRoot(state.root, state.dir)
  const saved = loadState(state.root)
  if (saved.taskId !== state.taskId) fail('This folder belongs to another task.')
  const before = fs.statSync(state.root)
  if (saved.token) {
    try {
      const response = await fetch(apiUrl(saved.api) + prefix + '/release', {
        method: 'POST', headers: { Authorization: 'Bearer ' + saved.token }, redirect: 'error', signal: AbortSignal.timeout(3_000),
      })
      await response.body?.cancel()
    } catch {}
  }
  protectRoot(state.root, state.dir)
  const after = fs.statSync(state.root)
  if (before.dev !== after.dev || before.ino !== after.ino || loadState(state.root).taskId !== state.taskId) fail('This folder belongs to another task.')
  fs.rmSync(state.root, { recursive: true })
  line(cleanupMessage)
}

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
Object.assign(gitEnv, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' })
function git(dir, args, { env, allowed = [0], maxBuffer = 2_000_000, overflow, hint, input } = {}) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: { ...gitEnv, ...env }, maxBuffer, input })
  if (result.error?.code === 'ENOBUFS' && overflow) fail(overflow)
  if (result.error?.code === 'ENOENT' && !fs.existsSync(dir)) fail('The task folder is missing. Restore the clone or choose the correct folder.')
  if (result.error?.code === 'ENOENT') fail('Git is unavailable. Install git on the cloud computer and try again.')
  if (result.error || !allowed.includes(result.status)) fail(hint ?? 'Git could not finish ' + args[0] + '. Check the repository and try again.')
  return result
}
function gitText(dir, args, options) { return git(dir, args, options).stdout.toString('utf8').trim() }

function readText(dir, file) {
  try {
    const location = path.join(dir, file)
    const stat = fs.lstatSync(location)
    return stat.isFile() && stat.size <= 1_000_000 ? fs.readFileSync(location, 'utf8') : ''
  } catch { return '' }
}
function has(dir, file) { return fs.existsSync(path.join(dir, file)) }
function detect(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail('The folder for command detection does not exist. Pass the repository folder with --dir.')
  const install = [], test = [], notes = []
  const add = (list, command, source) => { list.push({ command, source }) }
  let pkg
  try { pkg = JSON.parse(readText(dir, 'package.json')) } catch { pkg = null }
  const locks = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']]
  const declared = /^(pnpm|yarn|bun|npm)@/.exec(pkg?.packageManager)?.[1]
  const lock = locks.find(([file]) => has(dir, file))
  const manager = declared ?? lock?.[1] ?? 'npm'
  const berry = /^yarn@(?:[2-9]|\d{2,})\./.test(pkg?.packageManager) || has(dir, '.yarnrc.yml')
  const installCommands = { pnpm: 'pnpm install --frozen-lockfile', yarn: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile', bun: 'bun install --frozen-lockfile', npm: has(dir, 'package-lock.json') ? 'npm ci' : 'npm install' }
  if (pkg || lock) add(install, installCommands[manager], declared ? 'package.json packageManager' : lock?.[0] ?? 'package.json')
  for (const name of ['test', 'lint', 'typecheck']) {
    if (typeof pkg?.scripts?.[name] === 'string') add(test, manager + (name === 'test' || manager === 'yarn' ? ' ' : ' run ') + name, 'package.json scripts.' + name)
  }
  const make = ['Makefile', 'makefile', 'GNUmakefile'].find((file) => has(dir, file))
  if (make) {
    const targets = new Set([...readText(dir, make).matchAll(/^([\w-]+)\s*:(?!=)/gm)].map((match) => match[1]))
    for (const target of ['install', 'setup', 'deps', 'test', 'check']) if (targets.has(target)) add(['test', 'check'].includes(target) ? test : install, 'make ' + target, make)
  }
  const py = readText(dir, 'pyproject.toml')
  const poetry = has(dir, 'poetry.lock') || /^\[tool\.poetry(?:\.[^\]]+)?\]/m.test(py) || py.includes('poetry.core.masonry.api')
  const uv = !poetry && (has(dir, 'uv.lock') || /^\[tool\.uv(?:\.[^\]]+)?\]/m.test(py))
  if (has(dir, 'pyproject.toml')) add(install, poetry ? 'poetry install' : uv ? 'uv sync' : 'python -m pip install -e .', 'pyproject.toml')
  const requirements = readText(dir, 'requirements.txt')
  if (has(dir, 'requirements.txt')) add(install, 'python -m pip install -r requirements.txt', 'requirements.txt')
  const pytest = ['pytest.ini', '.pytest.ini', 'pytest.toml', '.pytest.toml'].find((file) => has(dir, file))
  if (pytest || /\bpytest\b/.test(py + '\n' + requirements) || has(dir, 'tests/conftest.py') || has(dir, 'conftest.py')) add(test, (poetry ? 'poetry run ' : uv ? 'uv run ' : '') + 'pytest', pytest ?? (/\bpytest\b/.test(py) ? 'pyproject.toml' : /\bpytest\b/.test(requirements) ? 'requirements.txt' : 'conftest.py'))
  if (has(dir, 'tox.ini')) add(test, 'tox', 'tox.ini')
  if (has(dir, 'go.mod')) add(test, 'go test ./...', 'go.mod')
  if (has(dir, 'Cargo.toml')) add(test, 'cargo test', 'Cargo.toml')
  if (has(dir, 'Gemfile')) {
    add(install, 'bundle install', 'Gemfile')
    if (/\brspec\b/.test(readText(dir, 'Gemfile')) || has(dir, 'spec')) add(test, 'bundle exec rspec', 'Gemfile')
    else if (has(dir, 'Rakefile') || has(dir, 'test')) add(test, 'bundle exec rake test', 'Gemfile')
  }
  const workflows = path.join(dir, '.github', 'workflows')
  if (['.github', '.github/workflows'].every((folder) => has(dir, folder) && fs.lstatSync(path.join(dir, folder)).isDirectory())) {
    for (const file of fs.readdirSync(workflows, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name)).map((entry) => entry.name).sort()) {
      let blockIndent
      for (const row of readText(workflows, file).split(/\r?\n/)) {
        const match = /^(\s*)(?:-\s*)?run:\s*(.+?)\s*$/.exec(row)
        const indent = /^\s*/.exec(row)[0].length
        if (blockIndent !== undefined && row.trim() && indent <= blockIndent) blockIndent = undefined
        if (match && /^[|>][-+\d]*$/.test(match[2])) { blockIndent = match[1].length; continue }
        let command = match?.[2] ?? (blockIndent !== undefined ? row.trim() : '')
        command = command.replace(/^(['"])(.*)\1$/, '$2')
        if (/^(?:(?:pnpm|yarn|bun|npm|poetry|bundle) install|npm ci|uv (?:sync|pip install)|(?:pip3?|python3? -m pip) install|make (?:install|setup|deps)|go mod download|cargo fetch)(?:\s|$)/.test(command)) add(install, command, 'CI: ' + file)
        if (/^(?:(?:pnpm|yarn|bun|npm) (?:run )?(?:test|lint|typecheck|check)(?=[:\s]|$)|(?:poetry run |uv run )?(?:python3? -m )?(?:pytest|tox)(?=\s|$)|(?:go|cargo|rake) test(?=\s|$)|bundle exec (?:rspec|rake test)(?=\s|$)|make (?:test|check)(?=\s|$))/.test(command)) add(test, command, 'CI: ' + file)
      }
    }
  }
  for (const file of fs.readdirSync(dir).filter((file) => /^readme(?:\.(?:md|markdown|rst|txt))?$/i.test(file)).sort()) {
    for (const heading of readText(dir, file).matchAll(/^#{1,6}\s+(.+)$/gm)) {
      if (/setup|getting started|install|tests?|testing|prerequisites/i.test(heading[1])) notes.push(file + ': ' + heading[1].trim())
    }
  }
  return { install, test, notes }
}
function printDetection(result) {
  for (const [label, entries] of [['Install', result.install], ['Test and checks', result.test]]) {
    if (!entries.length) line(label + ': No command found. Check the README.')
    for (const { command, source } of entries) line(label + ': ' + command + ' (' + source + ')')
  }
  for (const note of result.notes) line('See ' + note + '.')
}

function assertEmptyCheckout(dir) {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (stat && (!stat.isDirectory() || fs.readdirSync(dir).length !== 0)) fail('The clone destination is not an empty folder. Restore the working folder before running setup again.')
}
function shellQuote(value) { return '"' + value.replace(/["\\$\x60]/g, '\\$&') + '"' }
function waitCommand(root) { return 'node ' + shellQuote(path.join(root, 'openwork-code.mjs')) + ' wait --root ' + shellQuote(root) }
function setupSummary(state) {
  line('Work in: ' + state.dir)
  line('Base branch: ' + state.baseBranch)
  printDetection(detect(state.dir))
  line('Never push with git yourself. When the change is ready run: node ' + script + ' request-push --help')
}
async function setup(options) {
  const code = required(options, '--code', 200)
  secrets.add(code)
  const api = apiUrl(required(options, '--api', 4000))
  const root = workingRoot(options, true)
  const existing = loadState(root, true)
  protectRoot(root, existing?.dir)
  if (!existing && fs.readdirSync(root).some((name) => name !== 'openwork-code.mjs')) fail('The working folder is not empty. Choose a private folder for this task with --root.')
  fs.chmodSync(root, 0o700)
  const { taskId, token, tokenExpiresAt, repository, baseBranch, author } = await gateway({ api }, '/setup', { method: 'POST', body: { code } })
  secrets.add(token)
  const saved = loadState(root, true)
  if (saved && (saved.taskId !== taskId || saved.api !== api)) fail('This folder belongs to another task.')
  if (typeof taskId !== 'string' || !taskIdPattern.test(taskId)) fail('Den returned an invalid task ID. Ask for a new setup command.')
  const state = saved ? { ...saved, token, tokenExpiresAt } : { root, api, taskId, token, tokenExpiresAt, repository, baseBranch, author, dir: checkoutPath(root, repository), baseSha: null }
  saveState(state)
  if (state.baseSha) {
    setupSummary(state)
    if (state.approval) {
      const { approval } = await gateway(state, approvalPath(state.approval.id))
      line('Push approval: ' + approval.status)
      line('Run: ' + waitCommand(root))
    }
    return
  }
  assertEmptyCheckout(state.dir)
  const readToken = await gateway(state, '/read-token', { method: 'POST' })
  secrets.add(readToken.token)
  const cloneUrl = new URL(readToken.cloneUrl)
  if (cloneUrl.href !== new URL(state.repository.cloneUrl).href || cloneUrl.username || cloneUrl.password || cloneUrl.search || cloneUrl.hash || (cloneUrl.protocol !== 'https:' && !(loopback(new URL(api)) && (cloneUrl.protocol === 'file:' || (cloneUrl.protocol === 'http:' && loopback(cloneUrl)))))) fail('Den returned an unexpected clone address. Ask for a new setup command.')
  const basic = Buffer.from('x-access-token:' + readToken.token).toString('base64')
  secrets.add(basic)
  git(process.cwd(), ['-c', 'http.followRedirects=false', 'clone', '--template=', '--branch', state.baseBranch, '--single-branch', '--', cloneUrl.href, state.dir], {
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + basic },
    hint: 'Could not clone the repository. Check that the repository is available, then run setup again.',
  })
  git(state.dir, ['config', '--local', '--', 'user.name', state.author.name])
  git(state.dir, ['config', '--local', '--', 'user.email', state.author.email])
  state.baseSha = gitText(state.dir, ['rev-parse', 'HEAD'])
  saveState(state)
  setupSummary(state)
}

function changeFiles(dir, base, target) {
  const raw = git(dir, ['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-abbrev', '-O/dev/null', base, target, '--'], { maxBuffer: 1_300_000, overflow: tooLarge }).stdout
  const text = raw.toString('utf8')
  if (!raw.equals(Buffer.from(text))) fail('A changed path is not valid UTF-8. Rename it with a plain file name before trying again.')
  const fields = text.split('\0')
  if (fields.length === 1) fail('There are no changes to push. Edit the repository and try again.')
  if (fields.length > 601) fail(tooLarge)
  let total = 0
  const files = []
  for (let i = 0; i < fields.length - 1; i += 2) {
    const entry = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/.exec(fields[i])
    if (!entry) fail('Git returned an unsupported change. Check the changes and try again.')
    const [, oldMode, mode, , blob, status] = entry
    const file = fields[i + 1]
    if ((file.toLowerCase() + '/').startsWith('.github/workflows/')) fail('OpenWork can’t change GitHub Actions workflows ("' + file + '"). Leave files under .github/workflows out of this change and tell the person to edit them by hand.')
    if (file.length > 1024 || /[\\\x00-\x1f\x7f]/.test(file) || file.split('/').some((part) => ['', '.', '..', '.git'].includes(part.toLowerCase()))) fail('A changed path is not a file path inside the repository. Rename it before trying again.')
    if (['120000', '160000'].includes(oldMode) || ['120000', '160000'].includes(mode)) fail('OpenWork can’t change symlinks or submodules. Leave "' + file + '" out of this change.')
    if (status === 'D') { files.push({ path: file, deleted: true }); continue }
    if (mode !== '100644' && mode !== '100755') fail('A changed file has an unsupported mode. Leave "' + file + '" out of this change.')
    const bytes = git(dir, ['cat-file', 'blob', blob], { maxBuffer: 1_000_001, overflow: tooLarge }).stdout
    total += bytes.length
    if (bytes.length > 1_000_000 || total > 8_000_000) fail(tooLarge)
    files.push({ path: file, mode, contentBase64: bytes.toString('base64') })
  }
  return files
}
function changeSet(state, branch, commit) {
  if (!shaPattern.test(state.baseSha) || !shaPattern.test(commit)) fail('The saved Git revision is missing or invalid. Restore the clone and run request-push again.')
  const data = git(state.dir, ['cat-file', 'commit', commit], { hint: 'The saved local commit is missing. Restore it or run request-push again.' }).stdout.toString('utf8')
  const commitMessage = data.slice(data.indexOf('\n\n') + 2)
  if (!commitMessage.trim() || commitMessage.length > 10_000) fail('Use a non-empty commit message of at most 10,000 characters. Run request-push again with --message.')
  return { branch, baseSha: state.baseSha, commitMessage, files: changeFiles(state.dir, state.baseSha, commit) }
}
function approvalPath(id) { return '/push-approvals/' + encodeURIComponent(id) }
async function finishApproval(state, duration, approval) {
  const { id, branch, commit } = state.approval
  const endpoint = approvalPath(id)
  const deadline = Date.now() + duration
  while (!approval || (approval.status === 'pending' && Date.now() < deadline)) {
    const started = Date.now()
    const pollMs = Math.min(25_000, Math.max(0, deadline - started))
    try {
      ;({ approval } = await gateway(state, endpoint + (pollMs > 0 ? '?waitMs=' + pollMs : ''), { pollMs: pollMs || undefined, deadline: duration > 0 ? deadline : undefined }))
    } catch (error) {
      if (error === pollDeadlineReached) break
      throw error
    }
    if (approval.status === 'pending' && Date.now() < deadline) await sleep(Math.max(0, Math.min(deadline - Date.now(), 250 - (Date.now() - started))))
  }
  switch (approval?.status ?? 'pending') {
    case 'pending': fail('Still waiting for approval. Run: ' + waitCommand(state.root), 3); break
    case 'denied':
      line('The push was denied. Nothing was pushed. Ask what they would like changed.')
      await cleanup(state)
      process.exitCode = 4
      return
    case 'expired': case 'superseded': fail('This approval was ' + approval.status + '. Run request-push again to ask for approval.', 5); break
    case 'approved':
      try {
        await gateway(state, endpoint + '/push', { method: 'POST', body: { changeSet: changeSet(state, branch, commit) }, retryPost: true })
      } catch (error) {
        if (error.gatewayCode === 'commit_mismatch') fail(error.message + ' Run request-push again to ask for a new approval.')
        throw error
      }
      break
    case 'pushed': break
    default: fail('Den returned an unknown approval status. Check the push in OpenWork before trying again.')
  }
  const pr = approval.pullRequest ?? await gateway(state, '/pull-requests', { method: 'POST', body: { approvalId: id }, retryPost: true })
  line('Pull request opened: ' + pr.url)
  line(state.repository.fullName + ' #' + pr.number + ' · branch ' + branch)
  await cleanup(state)
}
async function requestPush(options) {
  const branch = required(options, '--branch', 200)
  const title = required(options, '--title', 255)
  const status = options['--tests']
  if (!['passed', 'failed', 'not_run'].includes(status)) fail('Set --tests to passed, failed, or not_run, matching what actually ran.')
  const tests = { status, command: optionalText(options, '--test-command', 500) ?? null, summary: optionalText(options, '--test-summary', 500) ?? null }
  const message = optionalText(options, '--message', 9999) ?? title
  const body = optionalText(options, '--body', 20_000)
  const duration = waitMs(options)
  if (!message.trim()) fail('The commit message is empty. Run request-push again with a non-empty message.')
  const state = loadState(workingRoot(options))
  requireCredential(state)
  if (!shaPattern.test(state.baseSha)) fail('This task has not been cloned. Run setup again before requesting a push.')
  const dir = state.dir
  if (fs.realpathSync(dir) !== dir || fs.realpathSync(gitText(dir, ['rev-parse', '--show-toplevel'])) !== dir) fail('Restore the checkout inside the working folder before requesting a push.')
  if (branch === state.repository.defaultBranch || branch === state.baseBranch) fail('OpenWork cannot push to the branch this work started from or to the default branch. Choose a new branch.')
  if (branch.startsWith('refs/') || branch.startsWith('-') || branch === 'HEAD' || branch === '@' || git(dir, ['check-ref-format', 'refs/heads/' + branch], { allowed: [0, 1] }).status !== 0) fail('That branch name cannot be used. Choose a name such as openwork/fix-rounding.')
  const diverged = git(dir, ['merge-base', '--is-ancestor', state.baseSha, 'HEAD'], { allowed: [0, 1, 128] }).status !== 0
  if (diverged) fail('This branch does not include the task’s original base commit. Return to a branch based on that commit and try again.')
  git(dir, ['add', '-A', '--', '.'])
  const stagedTree = gitText(dir, ['write-tree'], { hint: 'Git could not stage a complete change. Resolve any merge conflicts and try again.' })
  changeFiles(dir, state.baseSha, stagedTree)
  git(dir, ['switch', '-C', branch])
  if (gitText(dir, ['rev-parse', 'HEAD^{tree}']) !== stagedTree) {
    git(dir, ['commit', '--no-gpg-sign', '--cleanup=verbatim', '-F', '-'], { input: message.endsWith('\n') ? message : message + '\n' })
  }
  const commit = gitText(dir, ['rev-parse', 'HEAD'])
  const requested = changeSet({ ...state, dir }, branch, commit)
  git(dir, ['update-ref', 'refs/openwork/cloud-coding/' + state.taskId + '/' + commit, commit])
  const { approval } = await gateway(state, '/push-approvals', { method: 'POST', body: { changeSet: requested, title, body, tests } })
  const previous = state.approval
  state.approval = { id: approval.id, branch, commit }
  saveState({ ...loadState(state.root), approval: state.approval })
  if (previous && previous.commit !== commit && shaPattern.test(previous.commit)) {
    git(dir, ['update-ref', '-d', 'refs/openwork/cloud-coding/' + state.taskId + '/' + previous.commit], { allowed: [0, 1, 128] })
  }
  line('Asked ' + state.author.name + ' to approve pushing ' + requested.files.length + ' file(s) to a new branch ' + branch + ' on ' + state.repository.fullName + '. Waiting for their answer in OpenWork.')
  await finishApproval(state, duration, approval)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help') { help(); return }
  if (!Object.hasOwn(usage, command)) fail('Unknown command. Run node ' + script + ' --help for usage.')
  if (args.length === 1 && args[0] === '--help') { help(command); return }
  const options = optionsFor(command, args)
  switch (command) {
    case 'setup': await setup(options); return
    case 'detect': {
      if (options['--dir'] && options['--root']) fail('Use either --root or --dir, not both.')
      const dir = options['--dir'] ? path.resolve(options['--dir']) : loadState(workingRoot(options)).dir
      const result = detect(dir)
      if (options['--json']) json(result)
      else printDetection(result)
      return
    }
    case 'request-push': await requestPush(options); return
    case 'wait': {
      const duration = waitMs(options)
      const state = loadState(workingRoot(options))
      requireCredential(state)
      if (!state.approval) fail('No push approval has been requested yet. Run request-push --help to get started.')
      await finishApproval(state, duration)
      return
    }
    case 'finish': {
      const root = workingRoot(options)
      await cleanup(loadState(root))
      return
    }
    case 'status': {
      const state = loadState(workingRoot(options))
      requireCredential(state)
      const { approval } = state.approval ? await gateway(state, approvalPath(state.approval.id)) : { approval: null }
      const task = approval?.status === 'denied' || approval?.pullRequest ? state : await gateway(state, '/task')
      const { taskId, repository, baseBranch, author } = task
      if (options['--json']) json({ taskId, repository, baseBranch, author, dir: state.dir, approval })
      else {
        line('Repository: ' + repository.fullName + ' · base branch ' + baseBranch)
        line('Folder: ' + state.dir)
        line('Push approval: ' + (approval?.status ?? 'not requested'))
        if (approval?.pullRequest) line('Pull request: ' + approval.pullRequest.url)
      }
      return
    }
  }
}

main().catch((error) => {
  line(error instanceof Refusal ? error.message : 'Could not complete the cloud coding command. Check the task folder and try again, or ask for a new setup command.')
  process.exitCode = error instanceof Refusal ? error.exitCode : 1
})
`
