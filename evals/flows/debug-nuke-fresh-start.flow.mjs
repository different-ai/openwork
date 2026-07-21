import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { connect, debuggerUrlFor, pickAppTarget } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "debug-nuke-fresh-start";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

if (vo.length !== 5) {
  throw new Error(`Expected 5 voiceover frames for ${FLOW_ID}, found ${vo.length}.`);
}

const ENV_NAMES = [
  "OPENWORK_EVAL_WIN_SANDBOX_ID",
  "OPENWORK_EVAL_CDP_URL",
  "OPENWORK_EVAL_WIN_PROFILE",
];

const SANDBOX_ID = (process.env.OPENWORK_EVAL_WIN_SANDBOX_ID ?? "").trim();
const CDP_URL = cleanUrl(process.env.OPENWORK_EVAL_CDP_URL);
const INITIAL_INTERNAL_CDP_PORT = safeTcpPort(process.env.OPENWORK_EVAL_INITIAL_CDP_PORT) ?? 9222;
const CDP_DISCOVERY_PORTS = [9223, 9224, 9225, 9226, 9227];
const WIN_PROFILE = cleanWinPath(process.env.OPENWORK_EVAL_WIN_PROFILE ?? "");
const RUN_TAG = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const BRAND_APP_NAME = "Nuke Proof Work";
const BOOTSTRAP_BASE_URL = "https://openwork-poc.example.test";
const SEED_MARKER = `debug-nuke-seed-${RUN_TAG}`;
const FAKE_AUTH_TOKEN = `eval-fake-token-${RUN_TAG}`;
const LOCKER_SCRIPT_NAME = `openwork-nuke-locker-${RUN_TAG}.ps1`;
const paths = buildWindowsPaths(WIN_PROFILE);
const WIN_PROFILE_USER = winBasename(WIN_PROFILE);
const OUT_OF_BAND_BOOT_TASK_NAME = `OpenWorkNukeRetry-${RUN_TAG}`;
const OUT_OF_BAND_BOOT_CMD_PATH = winJoin(paths.windowsTemp, `openwork-nuke-retry-${RUN_TAG}.cmd`);
let currentCdpUrl = CDP_URL;
let currentInternalPort = INITIAL_INTERNAL_CDP_PORT;
let currentRelayPort = null;

const state = {
  firstReceiptPath: "",
  lockPid: 0,
  lockVerified: false,
  secondReceiptPath: "",
  afterLockedNuke: null,
  unlockProbe: null,
  killResult: null,
  afterBootGuard: null,
  executableProbe: null,
  outOfBandBoot: null,
  outOfBandCleanup: null,
  rendererSeedSnapshot: null,
};

function cleanUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function cleanWinPath(value) {
  return String(value ?? "").trim().replace(/[\\/]+$/, "");
}

function safeTcpPort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number.parseInt(text, 10);
  return port > 0 && port <= 65535 ? port : null;
}

function winJoin(base, ...segments) {
  const head = cleanWinPath(base);
  return [head, ...segments.map((segment) => String(segment).replace(/^[\\/]+|[\\/]+$/g, ""))].filter(Boolean).join("\\");
}

function winBasename(path) {
  const parts = cleanWinPath(path).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function buildWindowsPaths(profile) {
  const appData = winJoin(profile, "AppData", "Roaming");
  const localAppData = winJoin(profile, "AppData", "Local");
  const configHome = winJoin(localAppData, "openwork");
  const appDataOpenwork = winJoin(appData, "openwork");
  const userData = winJoin(appData, "com.differentai.openwork");
  const opencode = winJoin(appData, "opencode");
  const orchestrator = winJoin(profile, ".openwork", "openwork-orchestrator");
  const localShareOpencode = winJoin(profile, ".local", "share", "opencode");
  const cacheOpencode = winJoin(profile, ".cache", "opencode");
  return {
    appData,
    localAppData,
    configHome,
    appDataOpenwork,
    userData,
    opencode,
    orchestrator,
    localShareOpencode,
    cacheOpencode,
    bootstrap: winJoin(configHome, "desktop-bootstrap.json"),
    pending: winJoin(configHome, ".nuke-pending.json"),
    localRuntimeSqlite: winJoin(configHome, "runtime.sqlite"),
    temp: winJoin(localAppData, "Temp"),
    windowsTemp: "C:\\Windows\\Temp",
  };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function seededJson(value) {
  return psQuote(JSON.stringify({ ...value, seedMarker: SEED_MARKER, runTag: RUN_TAG }));
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function evidenceText(input) {
  if (typeof input === "string") return input.slice(0, 4000);
  return JSON.stringify(input, null, 2).slice(0, 4000);
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : evidenceText(actual),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${evidenceText(actual).slice(0, 500)})`));
}

function isDaytonaTimeout(result) {
  const message = result.error?.message ?? "";
  return result.error?.code === "ETIMEDOUT" || (result.signal === "SIGTERM" && /timed out|ETIMEDOUT/i.test(message));
}

function daytonaCmd(ctx, label, command, options = {}) {
  const attempts = Math.max(1, Number.isInteger(options.attempts) ? options.attempts : 1);
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("daytona", ["exec", SANDBOX_ID, "--", "cmd", "/c", command], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    });
    lastResult = result;
    const timeout = isDaytonaTimeout(result);
    const output = [
      `$ daytona exec ${SANDBOX_ID} -- cmd /c ${command}`,
      `attempt=${attempt}/${attempts}`,
      `exit=${result.status ?? "null"}`,
      result.signal ? `signal=${result.signal}` : "",
      result.error ? `error=${result.error.message}` : "",
      result.error?.code ? `errorCode=${result.error.code}` : "",
      timeout && attempt < attempts ? "retry=timeout" : "",
      result.stdout ? `stdout:\n${result.stdout}` : "stdout:",
      result.stderr ? `stderr:\n${result.stderr}` : "stderr:",
    ].filter(Boolean).join("\n");
    ctx.output(attempts > 1 ? `${label} attempt ${attempt}/${attempts}` : label, output);
    if (timeout && attempt < attempts) continue;
    if (result.error && options.allowFailure !== true) throw result.error;
    if (result.status !== 0 && options.allowFailure !== true) {
      throw new Error(`Daytona command ${label} failed with exit ${result.status}: ${result.stderr || result.stdout}`);
    }
    return result;
  }
  return lastResult;
}

function daytonaPowerShell(ctx, label, script, options = {}) {
  const encoded = encodePowerShell(`$ProgressPreference='SilentlyContinue'\n${script}`);
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  if (command.length > 7900) {
    throw new Error(`PowerShell payload for ${label} is too long for cmd /c (${command.length} chars). Split the command.`);
  }
  return daytonaCmd(ctx, label, command, options);
}

function balancedJsonAt(text, start) {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return null;
  const stack = [opener === "{" ? "}" : "]"];
  let inString = false;
  let escaping = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function extractJsonOutputValues(stdout) {
  const text = String(stdout ?? "");
  const values = [];
  for (let index = 0; index < text.length; index += 1) {
    const jsonText = balancedJsonAt(text, index);
    if (!jsonText) continue;
    try {
      values.push(JSON.parse(jsonText));
    } catch {
      // Keep scanning: Daytona shells may print non-JSON bracketed logs before the script JSON.
    }
    index += jsonText.length - 1;
  }
  return values;
}

export function parseJsonOutput(stdout, label) {
  const values = extractJsonOutputValues(stdout);
  if (values.length > 0) return values[values.length - 1];
  throw new Error(`Could not parse JSON output for ${label}: ${stdout}`);
}

function daytonaPowerShellJson(ctx, label, script, options = {}) {
  const result = daytonaPowerShell(ctx, label, script, options);
  return parseJsonOutput(result.stdout, label);
}

function relayPortForInternalPort(port) {
  return 10_000 + port;
}

function discoverCdpPortScript(previousPort) {
  return `
$ports=@(${CDP_DISCOVERY_PORTS.join(",")})
$exclude=${Number(previousPort) || 0}
$deadline=(Get-Date).AddSeconds(120)
$last=@()
do {
  $last=@()
  $connections=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains [int]$_.LocalPort })
  foreach($conn in $connections){
    $pidValue=[int]$conn.OwningProcess
    $name=$null
    $alive=$false
    try { $proc=Get-Process -Id $pidValue -ErrorAction Stop; $name=$proc.ProcessName; $alive=$true } catch {}
    $isOpenWork=$alive -and $name -eq 'OpenWork'
    $last += [pscustomobject][ordered]@{ port=[int]$conn.LocalPort; localAddress=[string]$conn.LocalAddress; pid=$pidValue; processName=$name; processAlive=$alive; isOpenWork=$isOpenWork }
  }
  $match=@($last | Where-Object { $_.isOpenWork -and $_.port -ne $exclude } | Sort-Object port | Select-Object -First 1)
  if($match.Count -gt 0){
    $result=[ordered]@{ found=$true; port=[int]$match[0].port; pid=[int]$match[0].pid; processName=[string]$match[0].processName; excludedPort=$exclude; candidates=$last }
    Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
    exit 0
  }
  Start-Sleep -Milliseconds 500
} while((Get-Date) -lt $deadline)
$result=[ordered]@{ found=$false; excludedPort=$exclude; candidates=$last }
Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
exit 47
`;
}

function configureCdpRelayScript(internalPort, relayPort, previousRelayPort) {
  return `
$internal=${Number(internalPort) || 0}
$relay=${Number(relayPort) || 0}
$previous=${Number(previousRelayPort) || 0}
$deletes=@()
foreach($p in @($previous,$relay) | Where-Object { $_ -gt 0 } | Select-Object -Unique){
  $out=& netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$p 2>&1
  $deletes += [pscustomobject][ordered]@{ port=$p; output=@($out | ForEach-Object { [string]$_ }) }
}
$addOut=& netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$relay connectaddress=127.0.0.1 connectport=$internal 2>&1
$addExit=$LASTEXITCODE
$showOut=& netsh interface portproxy show v4tov4 2>&1
$result=[ordered]@{ internalPort=$internal; relayPort=$relay; previousRelayPort=$previous; addExit=$addExit; addOutput=@($addOut | ForEach-Object { [string]$_ }); deleteOutput=$deletes; show=@($showOut | ForEach-Object { [string]$_ }) }
Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
if($addExit -ne 0){ exit 48 }
`;
}

function previewUrlForRelay(ctx, relayPort, label) {
  const result = spawnSync("daytona", ["preview-url", SANDBOX_ID, "-p", String(relayPort)], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  ctx.output(`${label} daytona-preview-url`, [
    `$ daytona preview-url ${SANDBOX_ID} -p ${relayPort}`,
    `exit=${result.status ?? "null"}`,
    result.signal ? `signal=${result.signal}` : "",
    result.error ? `error=${result.error.message}` : "",
    result.stdout ? `stdout:\n${result.stdout}` : "stdout:",
    result.stderr ? `stderr:\n${result.stderr}` : "stderr:",
  ].filter(Boolean).join("\n"));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`daytona preview-url failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  const lines = String(result.stdout ?? "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/https?:\/\/\S+/);
    if (match) return cleanUrl(match[0]);
  }
  throw new Error(`daytona preview-url did not print a URL for relay port ${relayPort}: ${result.stdout}`);
}

function discoverAndRelayCdp(ctx, label, previousPort) {
  const discovery = daytonaPowerShellJson(ctx, `${label} discover-active-cdp-port`, discoverCdpPortScript(previousPort), {
    allowFailure: true,
    timeoutMs: 140_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  ctx.output(`${label} cdp-discovery-json`, JSON.stringify(discovery, null, 2));
  if (discovery?.found !== true) {
    throw new Error(`${label}: no active OpenWork.exe CDP listener found on ${CDP_DISCOVERY_PORTS.join(", ")} excluding ${previousPort}.`);
  }
  const internalPort = safeTcpPort(discovery.port);
  if (!internalPort) throw new Error(`${label}: invalid discovered CDP port ${JSON.stringify(discovery.port)}.`);
  const relayPort = relayPortForInternalPort(internalPort);
  const relay = daytonaPowerShellJson(ctx, `${label} configure-cdp-portproxy`, configureCdpRelayScript(internalPort, relayPort, currentRelayPort), {
    timeoutMs: 30_000,
    maxBuffer: 1024 * 1024,
  });
  ctx.output(`${label} cdp-relay-json`, JSON.stringify(relay, null, 2));
  const previewUrl = previewUrlForRelay(ctx, relayPort, label);
  currentInternalPort = internalPort;
  currentRelayPort = relayPort;
  currentCdpUrl = previewUrl;
  ctx.cdpBaseUrl = currentCdpUrl;
  ctx.output(`${label} cdp-reattach-url`, JSON.stringify({ internalPort, relayPort, currentCdpUrl }, null, 2));
}

async function attachApp(ctx, timeoutMs = 90_000) {
  ctx.cdpBaseUrl = currentCdpUrl;
  try {
    ctx.client?.close();
  } catch {
    // The app may have relaunched between frames.
  }
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const target = await pickAppTarget(currentCdpUrl);
      const client = await connect(debuggerUrlFor(currentCdpUrl, target));
      await client.send("Page.enable").catch(() => undefined);
      ctx.client = client;
      ctx.log(`Attached to remote Windows Electron target: ${target.title || target.url}`);
      return target;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`Timed out after ${timeoutMs}ms attaching to ${currentCdpUrl}: ${lastError?.message ?? "unknown error"}`);
}

async function waitForAppShell(ctx, label = "OpenWork renderer") {
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 60_000, label: `${label} document complete` });
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__)", { timeoutMs: 60_000, label: `${label} Electron bridge` });
}

async function waitForRendererDisconnect(ctx, label, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await ctx.client.send("Runtime.evaluate", { expression: "1", returnByValue: true });
    } catch {
      ctx.log(`${label}: renderer CDP disconnected.`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label} to disconnect the renderer.`);
}

async function waitForRelaunch(ctx, label) {
  const previousPort = currentInternalPort;
  await waitForRendererDisconnect(ctx, label);
  discoverAndRelayCdp(ctx, label, previousPort);
  await attachApp(ctx, 120_000);
  await waitForAppShell(ctx, `${label} relaunched app`);
}

async function bootOutOfBandForLockedRetry(ctx, executablePath) {
  const previousPort = currentInternalPort;
  state.outOfBandBoot = daytonaPowerShellJson(ctx, "out-of-band-windows-boot-for-locked-retry", outOfBandWindowsBootScript(executablePath), {
    timeoutMs: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  ctx.output("out-of-band-windows-boot-json", JSON.stringify(state.outOfBandBoot, null, 2));
  discoverAndRelayCdp(ctx, "out-of-band locked-path retry boot", previousPort);
  await attachApp(ctx, 120_000);
  await waitForAppShell(ctx, "out-of-band locked-path retry boot relaunched app");
  state.outOfBandCleanup = daytonaPowerShellJson(ctx, "cleanup-out-of-band-windows-boot-task", cleanupOutOfBandBootTaskScript(), {
    allowFailure: true,
    timeoutMs: 30_000,
    maxBuffer: 1024 * 1024,
  });
  ctx.output("cleanup-out-of-band-windows-boot-json", JSON.stringify(state.outOfBandCleanup, null, 2));
}

async function enableRendererState(ctx, options = {}) {
  const includePreferences = options.includePreferences !== false;
  await ctx.eval(`(() => {
    localStorage.setItem('openwork.developerMode', '1');
    localStorage.setItem('openwork.den.authToken', ${JSON.stringify(FAKE_AUTH_TOKEN)});
    localStorage.setItem('openwork.den.activeOrgId', 'org_eval_debug_nuke');
    localStorage.setItem('openwork.den.activeOrgSlug', 'debug-nuke');
    localStorage.setItem('openwork.den.activeOrgName', 'Debug Nuke Eval');
    localStorage.setItem('openwork.react.settings.theme-mode', 'light');
    if (${includePreferences ? "true" : "false"}) {
      localStorage.setItem('openwork.preferences', JSON.stringify({ hasCompletedOnboarding: true, seededBy: ${JSON.stringify(FLOW_ID)}, runTag: ${JSON.stringify(RUN_TAG)} }));
    }
    return true;
  })()`);
  const marker = `debug-nuke-reload-${Date.now()}`;
  await ctx.eval(`(() => { window.__debugNukeReloadMarker = ${JSON.stringify(marker)}; location.reload(); return true; })()`);
  await ctx.waitFor(
    `window.__debugNukeReloadMarker !== ${JSON.stringify(marker)} && document.readyState === 'complete' && Boolean(window.__OPENWORK_ELECTRON__)`,
    { timeoutMs: 60_000, label: "renderer reload after eval storage seed" },
  );
  const authSnapshot = await ctx.eval(`(() => {
    localStorage.setItem('openwork.den.authToken', ${JSON.stringify(FAKE_AUTH_TOKEN)});
    localStorage.setItem('openwork.den.activeOrgId', 'org_eval_debug_nuke');
    localStorage.setItem('openwork.den.activeOrgSlug', 'debug-nuke');
    localStorage.setItem('openwork.den.activeOrgName', 'Debug Nuke Eval');
    const token = localStorage.getItem('openwork.den.authToken');
    return {
      authTokenPresent: Boolean(token),
      authTokenMatches: token === ${JSON.stringify(FAKE_AUTH_TOKEN)},
      authToken: token ? '<seeded>' : null,
      activeOrgId: localStorage.getItem('openwork.den.activeOrgId'),
      activeOrgSlug: localStorage.getItem('openwork.den.activeOrgSlug'),
      activeOrgName: localStorage.getItem('openwork.den.activeOrgName'),
    };
  })()`);
  witness(ctx, authSnapshot.authTokenMatches === true, "Renderer localStorage accepted the seeded fake openwork.den.authToken after reload", authSnapshot);
  witness(ctx, authSnapshot.activeOrgId === "org_eval_debug_nuke", "Renderer localStorage accepted the seeded active organization after reload", authSnapshot);
  return authSnapshot;
}

async function navigateToSettings(ctx, tab) {
  await ctx.navigateHash(`/settings/${tab}`);
  await ctx.waitFor(`location.hash.includes(${JSON.stringify(`/settings/${tab}`)})`, {
    timeoutMs: 30_000,
    label: `${tab} settings hash`,
  });
}

async function clickButtonByText(ctx, text, timeoutMs = 30_000) {
  const clicked = await ctx.waitFor(`(() => {
    const wanted = ${JSON.stringify(text)};
    const buttons = [...document.querySelectorAll('button, [role="button"]')];
    for (const el of buttons) {
      const label = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      if (label.includes(wanted) && !disabled) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return label;
      }
    }
    return null;
  })()`, { timeoutMs, label: `enabled button ${JSON.stringify(text)}` });
  ctx.log(`Clicked button: ${clicked}`);
  return clicked;
}

async function openNukeDialog(ctx) {
  await navigateToSettings(ctx, "debug");
  await ctx.waitForText("Danger zone", { timeoutMs: 90_000 });
  await ctx.waitForText("Nuke & fresh start", { timeoutMs: 90_000 });
  await clickButtonByText(ctx, "Nuke & fresh start", 90_000);
  await ctx.waitForText("Nuke local state and start fresh?", { timeoutMs: 60_000 });
  await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"Type NUKE\"]'))", {
    timeoutMs: 20_000,
    label: "NUKE confirmation input",
  });
}

async function executeNukeFromDialog(ctx, label) {
  await ctx.fill('input[placeholder="Type NUKE"]', "NUKE");
  await clickButtonByText(ctx, "Nuke & relaunch", 20_000);
  await waitForRelaunch(ctx, label);
}

function bootstrapFixture() {
  return {
    baseUrl: BOOTSTRAP_BASE_URL,
    requireSignin: true,
    brandAppName: BRAND_APP_NAME,
    brandIconUrl: "https://openwork-poc.example.test/icon.png",
    seedMarker: SEED_MARKER,
    runTag: RUN_TAG,
    handoff: {
      grant: "secret-grant",
      denBaseUrl: BOOTSTRAP_BASE_URL,
      orgId: "org_debug_nuke",
      orgName: "Debug Nuke Org",
      orgSlug: "debug-nuke-org",
      seedMarker: SEED_MARKER,
      runTag: RUN_TAG,
      createdAt: "2026-07-20T00:00:00.000Z",
    },
    prepared: {
      orgId: "org_debug_nuke",
      orgName: "Debug Nuke Org",
      orgSlug: "debug-nuke-org",
      skillId: "skill_secret_prepared",
      skillTitle: "Secret Prepared Skill",
      skillsDir: "C:\\secret\\skills",
      skillPath: "C:\\secret\\skills\\prepared",
      seedMarker: SEED_MARKER,
      runTag: RUN_TAG,
      preparedAt: "2026-07-20T00:01:00.000Z",
    },
    claimLinks: [
      {
        id: "claim_debug_nuke",
        role: "admin",
        token: "secret-token",
        url: `${BOOTSTRAP_BASE_URL}/claim/debug-nuke`,
        seedMarker: SEED_MARKER,
        runTag: RUN_TAG,
        expiresAt: "2026-07-20T00:05:00.000Z",
      },
    ],
    writtenAt: "2026-07-20T00:00:00.000Z",
  };
}

function seedOpenworkConfigAndUserDataScript() {
  return `
$profilePath=${psQuote(WIN_PROFILE)}
$userData=${psQuote(paths.userData)}
$appOpenwork=${psQuote(paths.appDataOpenwork)}
$configHome=${psQuote(paths.configHome)}
$dirs=@($userData,$appOpenwork,$configHome)
foreach($dir in $dirs){ New-Item -ItemType Directory -Force -Path $dir | Out-Null }
Set-Content -Path (Join-Path $userData 'eval-userdata-marker.txt') -Value ${psQuote(`delete-me-userdata ${SEED_MARKER} ${RUN_TAG}`)} -Encoding UTF8
Set-Content -Path (Join-Path $appOpenwork 'server.json') -Value ${seededJson({ server: "dummy" })} -Encoding UTF8
Set-Content -Path (Join-Path $appOpenwork 'env.json') -Value ${seededJson({ APPDATA_ENV: "dummy" })} -Encoding UTF8
Set-Content -Path (Join-Path $appOpenwork 'tokens.json') -Value ${seededJson({ APPDATA_TOKEN: "dummy" })} -Encoding UTF8
[IO.File]::WriteAllBytes((Join-Path $appOpenwork 'runtime.sqlite'), [Text.Encoding]::UTF8.GetBytes('dummy appdata runtime db ${SEED_MARKER} ${RUN_TAG}'))
Set-Content -Path (Join-Path $configHome 'env.json') -Value ${seededJson({ LOCAL_ENV: "dummy" })} -Encoding UTF8
Set-Content -Path (Join-Path $configHome 'tokens.json') -Value ${seededJson({ LOCAL_TOKEN: "dummy" })} -Encoding UTF8
$result=[ordered]@{ profile=$profilePath; userData=$userData; appOpenwork=$appOpenwork; configHome=$configHome }
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
`;
}

function seedDesktopBootstrapScript() {
  return `
$configHome=${psQuote(paths.configHome)}
New-Item -ItemType Directory -Force -Path $configHome | Out-Null
$bootstrapPath=Join-Path $configHome 'desktop-bootstrap.json'
[System.IO.File]::WriteAllText($bootstrapPath, ${psQuote(JSON.stringify(bootstrapFixture()))}, [System.Text.UTF8Encoding]::new($false))
$result=[ordered]@{ bootstrap=(Join-Path $configHome 'desktop-bootstrap.json'); baseUrl=${psQuote(BOOTSTRAP_BASE_URL)}; brandAppName=${psQuote(BRAND_APP_NAME)}; secretFixture=$true }
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
`;
}

function seedOpencodeAndOrchestratorScript() {
  return `
$opencode=${psQuote(paths.opencode)}
$orchestrator=${psQuote(paths.orchestrator)}
$localShareOpencode=${psQuote(paths.localShareOpencode)}
$cacheOpencode=${psQuote(paths.cacheOpencode)}
$dirs=@($opencode,$orchestrator,$localShareOpencode,$cacheOpencode)
foreach($dir in $dirs){ New-Item -ItemType Directory -Force -Path $dir | Out-Null }
Set-Content -Path (Join-Path $opencode 'auth.json') -Value ${seededJson({ token: "dummy-opencode-auth" })} -Encoding UTF8
Set-Content -Path (Join-Path $opencode 'mcp-auth.json') -Value ${seededJson({ mcp: "dummy-opencode-mcp-auth" })} -Encoding UTF8
[IO.File]::WriteAllBytes((Join-Path $opencode 'opencode.db'), [Text.Encoding]::UTF8.GetBytes('dummy opencode db ${SEED_MARKER} ${RUN_TAG}'))
Set-Content -Path (Join-Path $orchestrator 'openwork-orchestrator-auth.json') -Value ${seededJson({ orchestrator: "dummy" })} -Encoding UTF8
Set-Content -Path (Join-Path $localShareOpencode 'data-marker.txt') -Value ${psQuote(`dummy local share opencode ${SEED_MARKER} ${RUN_TAG}`)} -Encoding UTF8
Set-Content -Path (Join-Path $cacheOpencode 'cache-marker.txt') -Value ${psQuote(`dummy cache opencode ${SEED_MARKER} ${RUN_TAG}`)} -Encoding UTF8
$result=[ordered]@{ opencode=$opencode; orchestrator=$orchestrator; localShareOpencode=$localShareOpencode; cacheOpencode=$cacheOpencode }
Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
`;
}

function seededDirectoriesListingScript() {
  return `
function ChildNames($p){ if(Test-Path -LiteralPath $p){ @(Get-ChildItem -LiteralPath $p -Force | ForEach-Object { $_.Name }) } else { @() } }
$targets=@(
  [ordered]@{ name='opencode'; path=${psQuote(paths.opencode)} },
  [ordered]@{ name='configHome'; path=${psQuote(paths.configHome)} },
  [ordered]@{ name='orchestrator'; path=${psQuote(paths.orchestrator)} },
  [ordered]@{ name='userData'; path=${psQuote(paths.userData)} }
)
$result=[ordered]@{}
foreach($target in $targets){
  $result[$target.name]=[ordered]@{ path=$target.path; exists=(Test-Path -LiteralPath $target.path); children=(ChildNames $target.path) }
}
Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
`;
}

function fixtureProbeScript() {
  return `
$paths=@{
  userData=${psQuote(paths.userData)}; opencode=${psQuote(paths.opencode)}; appOpenwork=${psQuote(paths.appDataOpenwork)}; configHome=${psQuote(paths.configHome)}; orchestrator=${psQuote(paths.orchestrator)}; localShareOpencode=${psQuote(paths.localShareOpencode)}; cacheOpencode=${psQuote(paths.cacheOpencode)}; bootstrap=${psQuote(paths.bootstrap)}
}
$checks=[ordered]@{}
foreach($name in $paths.Keys){ $checks[$name]=[ordered]@{ path=$paths[$name]; exists=(Test-Path -LiteralPath $paths[$name]) } }
$checks['opencode']['auth']=Test-Path -LiteralPath (Join-Path $paths.opencode 'auth.json')
$checks['opencode']['mcpAuth']=Test-Path -LiteralPath (Join-Path $paths.opencode 'mcp-auth.json')
$checks['opencode']['db']=Test-Path -LiteralPath (Join-Path $paths.opencode 'opencode.db')
$checks['userData']['marker']=Test-Path -LiteralPath (Join-Path $paths.userData 'eval-userdata-marker.txt')
$checks['appOpenwork']['server']=Test-Path -LiteralPath (Join-Path $paths.appOpenwork 'server.json')
$checks['appOpenwork']['env']=Test-Path -LiteralPath (Join-Path $paths.appOpenwork 'env.json')
$checks['appOpenwork']['tokens']=Test-Path -LiteralPath (Join-Path $paths.appOpenwork 'tokens.json')
$checks['appOpenwork']['runtime']=Test-Path -LiteralPath (Join-Path $paths.appOpenwork 'runtime.sqlite')
$checks['configHome']['env']=Test-Path -LiteralPath (Join-Path $paths.configHome 'env.json')
$checks['configHome']['tokens']=Test-Path -LiteralPath (Join-Path $paths.configHome 'tokens.json')
$checks['configHome']['bootstrap']=Test-Path -LiteralPath $paths.bootstrap
$checks['orchestrator']['auth']=Test-Path -LiteralPath (Join-Path $paths.orchestrator 'openwork-orchestrator-auth.json')
$checks['localShareOpencode']['dataMarker']=Test-Path -LiteralPath (Join-Path $paths.localShareOpencode 'data-marker.txt')
$checks['cacheOpencode']['cacheMarker']=Test-Path -LiteralPath (Join-Path $paths.cacheOpencode 'cache-marker.txt')
Write-Output ($checks | ConvertTo-Json -Depth 6 -Compress)
`;
}

function postNukeStateRootsProbeScript() {
  return `
function N($p){if(Test-Path -LiteralPath $p){@(Get-ChildItem -LiteralPath $p -Force|%{$_.Name})}else{@()}}
function S($r,$n){$p=Join-Path $r $n;$e=Test-Path -LiteralPath $p;$m=$false;$t=$false;if($e){try{$x=[IO.File]::ReadAllText($p);$m=$x.Contains($sm);$t=$x.Contains($rt)}catch{}}[ordered]@{name=$n;exists=$e;containsSeedMarker=$m;rawContainsRunTag=$t}}
function SS($r,$ns){@($ns|%{S $r $_})}
$sm=${psQuote(SEED_MARKER)};$rt=${psQuote(RUN_TAG)}
$u=${psQuote(paths.userData)};$o=${psQuote(paths.opencode)};$a=${psQuote(paths.appDataOpenwork)};$c=${psQuote(paths.configHome)}
$r=${psQuote(paths.orchestrator)};$s=${psQuote(paths.localShareOpencode)};$k=${psQuote(paths.cacheOpencode)};$p=${psQuote(paths.pending)}
$appOpenworkSeeded=SS $a @('server.json','env.json','tokens.json','runtime.sqlite')
$result=[ordered]@{
  userData=[ordered]@{path=$u;exists=(Test-Path -LiteralPath $u);markerExists=(Test-Path -LiteralPath (Join-Path $u 'eval-userdata-marker.txt'));seededFiles=(SS $u @('eval-userdata-marker.txt'));entries=(N $u)}
  opencode=[ordered]@{path=$o;exists=(Test-Path -LiteralPath $o);seededFiles=(SS $o @('auth.json','mcp-auth.json','opencode.db'));entries=(N $o)}
  appOpenwork=[ordered]@{path=$a;exists=(Test-Path -LiteralPath $a);seededFiles=$appOpenworkSeeded;entries=(N $a)}
  localOpenwork=[ordered]@{path=$c;exists=(Test-Path -LiteralPath $c);entries=(N $c);seededFiles=(SS $c @('env.json','tokens.json'));pendingExists=(Test-Path -LiteralPath $p);envExists=(Test-Path -LiteralPath (Join-Path $c 'env.json'));tokensExists=(Test-Path -LiteralPath (Join-Path $c 'tokens.json'))}
  orchestrator=[ordered]@{path=$r;exists=(Test-Path -LiteralPath $r);seededFiles=(SS $r @('openwork-orchestrator-auth.json'));entries=(N $r)}
  localShareOpencode=[ordered]@{path=$s;exists=(Test-Path -LiteralPath $s);seededFiles=(SS $s @('data-marker.txt'));entries=(N $s)}
  cacheOpencode=[ordered]@{path=$k;exists=(Test-Path -LiteralPath $k);seededFiles=(SS $k @('cache-marker.txt'));entries=(N $k)}
}
Write-Output ($result | ConvertTo-Json -Depth 7 -Compress)
`;
}

function postNukeBootstrapProbeScript() {
  return `
$bootstrap=${psQuote(paths.bootstrap)}
$seedMarker=${psQuote(SEED_MARKER)}
$runTag=${psQuote(RUN_TAG)}
$bootstrapRaw=''
$parsedOk=$false
$baseUrl=$null
$requireSignin=$null
$brandAppName=$null
$propertyNames=@()
if(Test-Path -LiteralPath $bootstrap){
  $bootstrapRaw=Get-Content -Raw -LiteralPath $bootstrap
  try {
    $parsed=$bootstrapRaw | ConvertFrom-Json
    $parsedOk=$true
    $propertyNames=@($parsed.PSObject.Properties | ForEach-Object { [string]$_.Name })
    $baseUrl=[string]$parsed.baseUrl
    if($null -ne $parsed.requireSignin){ $requireSignin=[bool]$parsed.requireSignin }
    $brandAppName=[string]$parsed.brandAppName
  } catch {}
}
$result=[ordered]@{
  path=$bootstrap
  exists=(Test-Path -LiteralPath $bootstrap)
  raw=$bootstrapRaw
  parsedOk=$parsedOk
  baseUrl=$baseUrl
  requireSignin=$requireSignin
  brandAppName=$brandAppName
  propertyNames=$propertyNames
  hasHandoff=($propertyNames -contains 'handoff')
  hasClaimLinks=($propertyNames -contains 'claimLinks')
  hasPrepared=($propertyNames -contains 'prepared')
  containsSecretGrant=$bootstrapRaw.Contains('secret-grant')
  containsSecretToken=$bootstrapRaw.Contains('secret-token')
  containsSeedMarker=$bootstrapRaw.Contains($seedMarker)
  rawContainsRunTag=$bootstrapRaw.Contains($runTag)
}
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
`;
}

function latestReceiptProbeScript() {
  return `
$tempCandidates=@(${psQuote(paths.temp)},${psQuote(paths.windowsTemp)}) | Select-Object -Unique
$receipts=@()
foreach($dir in $tempCandidates){ if(Test-Path -LiteralPath $dir){ $receipts += @(Get-ChildItem -LiteralPath $dir -Filter 'openwork-nuke-receipt-*.json' -File -ErrorAction SilentlyContinue) } }
$latest=$receipts | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$receiptRaw=''
$deletedCount=0
$pendingRetry=@()
$errorCount=0
$preservedBootstrap=$null
if($latest){
  $receiptRaw=Get-Content -Raw -LiteralPath $latest.FullName
  try {
    $receiptJson=$receiptRaw | ConvertFrom-Json
    if($null -ne $receiptJson.deleted){ $deletedCount=@($receiptJson.deleted).Count }
    $pendingRetry=@($receiptJson.pendingRetry | ForEach-Object { [string]$_ })
    if($null -ne $receiptJson.errors){ $errorCount=@($receiptJson.errors).Count }
    if($null -ne $receiptJson.preservedBootstrap){ $preservedBootstrap=[bool]$receiptJson.preservedBootstrap }
  } catch {}
}
$result=[ordered]@{ searched=$tempCandidates; path=$(if($latest){$latest.FullName}else{$null}); raw=$receiptRaw; deletedCount=$deletedCount; pendingRetry=$pendingRetry; errorCount=$errorCount; preservedBootstrap=$preservedBootstrap }
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
`;
}

function lockedStateScript() {
  return `
$lockedPath=${psQuote(paths.localRuntimeSqlite)}
$pendingPath=${psQuote(paths.pending)}
$tempCandidates=@(${psQuote(paths.temp)},${psQuote(paths.windowsTemp)}) | Select-Object -Unique
$receipts=@()
foreach($dir in $tempCandidates){ if(Test-Path -LiteralPath $dir){ $receipts += @(Get-ChildItem -LiteralPath $dir -Filter 'openwork-nuke-receipt-*.json' -File -ErrorAction SilentlyContinue) } }
$latest=$receipts | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$receiptRaw=''
$receiptPendingRetry=@()
$receiptDeletedCount=0
$receiptErrorCount=0
$receiptPreservedBootstrap=$null
if($latest){
  $receiptRaw=Get-Content -Raw -LiteralPath $latest.FullName
  try {
    $receiptJson=$receiptRaw | ConvertFrom-Json
    $receiptPendingRetry=@($receiptJson.pendingRetry | ForEach-Object { [string]$_ })
    if($null -ne $receiptJson.deleted){ $receiptDeletedCount=@($receiptJson.deleted).Count }
    if($null -ne $receiptJson.errors){ $receiptErrorCount=@($receiptJson.errors).Count }
    if($null -ne $receiptJson.preservedBootstrap){ $receiptPreservedBootstrap=[bool]$receiptJson.preservedBootstrap }
  } catch {}
}
$pendingRaw=''
$pendingPaths=@()
if(Test-Path -LiteralPath $pendingPath){
  $pendingRaw=Get-Content -Raw -LiteralPath $pendingPath
  try { $pendingPaths=@(($pendingRaw | ConvertFrom-Json).paths | ForEach-Object { [string]$_ }) } catch {}
}
$result=[ordered]@{ lockedPath=$lockedPath; lockedExists=(Test-Path -LiteralPath $lockedPath); pendingPath=$pendingPath; pendingExists=(Test-Path -LiteralPath $pendingPath); pendingRaw=$pendingRaw; pendingPaths=$pendingPaths; receiptPath=$(if($latest){$latest.FullName}else{$null}); receiptRaw=$receiptRaw; receiptPendingRetry=$receiptPendingRetry; receiptDeletedCount=$receiptDeletedCount; receiptErrorCount=$receiptErrorCount; receiptPreservedBootstrap=$receiptPreservedBootstrap }
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
`;
}

function lockRuntimeScript() {
  return `
$lockPath=${psQuote(paths.localRuntimeSqlite)}
$scriptPath=Join-Path ${psQuote(paths.temp)} ${psQuote(LOCKER_SCRIPT_NAME)}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lockPath) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $scriptPath) | Out-Null
Set-Content -Path $lockPath -Value 'locked runtime sqlite ${SEED_MARKER} ${RUN_TAG}' -Encoding UTF8
$locker=@'
$path = ${psQuote(paths.localRuntimeSqlite)}
$fs = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
  while ($true) { Start-Sleep -Seconds 1 }
} finally {
  $fs.Dispose()
}
'@
Set-Content -Path $scriptPath -Value $locker -Encoding UTF8
$process=Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath) -WindowStyle Hidden -PassThru
$locked=$false
$processExited=$false
$exitCode=$null
$waitedMs=0
for($i=0; $i -lt 60; $i++){
  Start-Sleep -Milliseconds 250
  $waitedMs += 250
  try { $process.Refresh() } catch {}
  if($process.HasExited){
    $processExited=$true
    try { $exitCode=[int]$process.ExitCode } catch {}
    break
  }
  try {
    $probe=[System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $probe.Dispose()
  } catch [System.IO.IOException] {
    $locked=$true
    break
  }
}
$result=[ordered]@{ path=$lockPath; script=$scriptPath; pid=$process.Id; locked=$locked; processExited=$processExited; exitCode=$exitCode; waitedMs=$waitedMs; exists=(Test-Path -LiteralPath $lockPath) }
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
if(-not $locked){ exit 44 }
`;
}

function unlockProbeScript() {
  return `
$lockPath=${psQuote(paths.localRuntimeSqlite)}
$unlocked=$false
$lastError=''
for($i=0; $i -lt 30; $i++){
  try { $probe=[System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); $probe.Dispose(); $unlocked=$true; break } catch { $lastError=$_.Exception.Message; Start-Sleep -Milliseconds 250 }
}
$result=[ordered]@{ path=$lockPath; exists=(Test-Path -LiteralPath $lockPath); unlocked=$unlocked; lastError=$lastError }
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
if(-not $unlocked){ exit 45 }
`;
}

function stopLockerScript(pid) {
  return `
$pidValue=${Number(pid) || 0}
$foundBefore=$false
$stopped=$false
$errorText=''
try {
  $process=Get-Process -Id $pidValue -ErrorAction Stop
  $foundBefore=$true
  Stop-Process -Id $pidValue -Force -ErrorAction Stop
  Start-Sleep -Milliseconds 500
  $stopped=$true
} catch {
  $errorText=$_.Exception.Message
}
$existsAfter=$false
try { $after=Get-Process -Id $pidValue -ErrorAction Stop; $existsAfter=$true } catch { $existsAfter=$false }
$result=[ordered]@{ pid=$pidValue; foundBefore=$foundBefore; stopped=$stopped; existsAfter=$existsAfter; error=$errorText }
Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
if(-not $stopped -or $existsAfter){ exit 46 }
`;
}

function discoverMainOpenWorkExecutableScript() {
  return `
$processes=@(Get-CimInstance Win32_Process -Filter "Name = 'OpenWork.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ($null -eq $_.CommandLine -or $_.CommandLine -notmatch '--type=') } | Sort-Object ProcessId)
$selected=$processes | Select-Object -First 1
$candidates=@($processes | ForEach-Object { [ordered]@{ processId=[int]$_.ProcessId; executablePath=[string]$_.ExecutablePath; commandLine=[string]$_.CommandLine } })
$exePath=$null
$processId=$null
if($selected){ $exePath=[string]$selected.ExecutablePath; $processId=[int]$selected.ProcessId }
$result=[ordered]@{ found=($null -ne $selected); executablePath=$exePath; processId=$processId; candidates=$candidates }
Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
if($null -eq $selected){ exit 52 }
`;
}

function outOfBandWindowsBootScript(executablePath) {
  return `
$exe=${psQuote(executablePath)}
$taskName=${psQuote(OUT_OF_BAND_BOOT_TASK_NAME)}
$cmdPath=${psQuote(OUT_OF_BAND_BOOT_CMD_PATH)}
$runUser=${psQuote(WIN_PROFILE_USER)}
$stopped=@();$remaining=@();$createOut=@();$runOut=@();$createExit=$null;$runExit=$null;$cmdText='';$errorText=''
if(-not $exe -or -not (Test-Path -LiteralPath $exe)){
  $result=[ordered]@{ executablePath=$exe; executableExists=$false; error='OpenWork executable path missing before out-of-band boot' }
  Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
  exit 53
}
try {
  foreach($proc in @(Get-Process -Name OpenWork -ErrorAction SilentlyContinue)){
    $entry=[ordered]@{ pid=$proc.Id; stopped=$false; error='' }
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop; $entry.stopped=$true } catch { $entry.error=$_.Exception.Message }
    $stopped += [pscustomobject]$entry
  }
  Start-Sleep -Milliseconds 1000
  foreach($proc in @(Get-Process -Name OpenWork -ErrorAction SilentlyContinue)){
    $remaining += [pscustomobject][ordered]@{ pid=$proc.Id }
  }
  $cmdText=('@echo off','set OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=','start "" "' + $exe + '"') -join [Environment]::NewLine
  [IO.File]::WriteAllText($cmdPath, $cmdText + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  $createArgs=@('/create','/f','/sc','once','/st','23:59','/ru',$runUser,'/it','/rl','highest','/tn',$taskName,'/tr',$cmdPath)
  $createOut=@(& schtasks @createArgs 2>&1 | ForEach-Object { [string]$_ })
  $createExit=$LASTEXITCODE
  if($createExit -eq 0){
    $runOut=@(& schtasks /run /tn $taskName 2>&1 | ForEach-Object { [string]$_ })
    $runExit=$LASTEXITCODE
  }
} catch {
  $errorText=$_.Exception.Message
}
$result=[ordered]@{ executablePath=$exe; executableExists=(Test-Path -LiteralPath $exe); runUser=$runUser; taskName=$taskName; cmdPath=$cmdPath; cmdText=$cmdText; stopped=$stopped; remainingBeforeRun=$remaining; createExit=$createExit; createOutput=$createOut; runExit=$runExit; runOutput=$runOut; error=$errorText }
Write-Output ($result | ConvertTo-Json -Depth 7 -Compress)
if($errorText){ exit 54 }
if($createExit -ne 0){ exit 55 }
if($runExit -ne 0){ exit 56 }
`;
}

function cleanupOutOfBandBootTaskScript() {
  return `
$taskName=${psQuote(OUT_OF_BAND_BOOT_TASK_NAME)}
$cmdPath=${psQuote(OUT_OF_BAND_BOOT_CMD_PATH)}
$deleteOut=@(& schtasks.exe /delete /f /tn $taskName 2>&1 | ForEach-Object { [string]$_ })
$deleteExit=$LASTEXITCODE
$cmdRemoved=$false
$cmdRemoveError=''
try { Remove-Item -LiteralPath $cmdPath -Force -ErrorAction Stop; $cmdRemoved=$true } catch { $cmdRemoveError=$_.Exception.Message }
$result=[ordered]@{ taskName=$taskName; cmdPath=$cmdPath; deleteExit=$deleteExit; deleteOutput=$deleteOut; cmdRemoved=$cmdRemoved; cmdRemoveError=$cmdRemoveError }
Write-Output ($result | ConvertTo-Json -Depth 5 -Compress)
`;
}

function containsPath(pathsToSearch, expectedPath) {
  const expected = cleanWinPath(expectedPath).toLowerCase();
  return arrayValue(pathsToSearch).some((entry) => {
    const candidate = cleanWinPath(entry).toLowerCase();
    return candidate === expected || candidate === cleanWinPath(paths.configHome).toLowerCase();
  });
}

function receiptPendingPaths(data) {
  return arrayValue(data?.receiptPendingRetry ?? data?.receipt?.pendingRetry);
}

function pendingFilePaths(data) {
  return arrayValue(data?.pendingPaths ?? data?.pending?.paths);
}

function childNames(entry) {
  return arrayValue(entry?.children).map(String);
}

function hasChild(entry, name) {
  return childNames(entry).includes(name);
}

function fileContainsSeed(entry) {
  return entry?.containsSeedMarker === true || entry?.rawContainsRunTag === true;
}

function seededMarkerSurvivors(data) {
  const rootNames = ["userData", "opencode", "appOpenwork", "localOpenwork", "orchestrator", "localShareOpencode", "cacheOpencode"];
  return rootNames.flatMap((rootName) =>
    arrayValue(data[rootName]?.seededFiles)
      .filter(fileContainsSeed)
      .map((entry) => ({
        root: rootName,
        name: entry?.name,
        path: entry?.path,
        exists: entry?.exists,
        containsSeedMarker: entry?.containsSeedMarker,
        rawContainsRunTag: entry?.rawContainsRunTag,
      })),
  );
}

function assertSeededDirectoryListing(ctx, listing) {
  witness(ctx, listing.opencode?.exists === true, "Seeded %APPDATA%\\opencode root exists", listing.opencode);
  witness(ctx, hasChild(listing.opencode, "auth.json"), "Seeded opencode directory lists auth.json", listing.opencode);
  witness(ctx, hasChild(listing.opencode, "mcp-auth.json"), "Seeded opencode directory lists mcp-auth.json", listing.opencode);
  witness(ctx, hasChild(listing.opencode, "opencode.db"), "Seeded opencode directory lists opencode.db", listing.opencode);
  witness(ctx, listing.configHome?.exists === true, "Seeded %LOCALAPPDATA%\\openwork root exists", listing.configHome);
  witness(ctx, hasChild(listing.configHome, "env.json"), "Seeded LOCALAPPDATA openwork directory lists env.json", listing.configHome);
  witness(ctx, hasChild(listing.configHome, "tokens.json"), "Seeded LOCALAPPDATA openwork directory lists tokens.json", listing.configHome);
  witness(ctx, hasChild(listing.configHome, "desktop-bootstrap.json"), "Seeded LOCALAPPDATA openwork directory lists desktop-bootstrap.json", listing.configHome);
  witness(ctx, listing.orchestrator?.exists === true, "Seeded profile .openwork\\openwork-orchestrator root exists", listing.orchestrator);
  witness(ctx, hasChild(listing.orchestrator, "openwork-orchestrator-auth.json"), "Seeded orchestrator directory lists openwork-orchestrator-auth.json", listing.orchestrator);
  witness(ctx, listing.userData?.exists === true, "Seeded %APPDATA%\\com.differentai.openwork userData root exists", listing.userData);
  witness(ctx, hasChild(listing.userData, "eval-userdata-marker.txt"), "Seeded userData directory lists eval-userdata-marker.txt", listing.userData);
}

function assertPostFirstNuke(ctx, data) {
  const localEntries = arrayValue(data.localOpenwork?.entries).map(String);
  const unexpectedLocal = localEntries.filter((entry) => entry !== "desktop-bootstrap.json");
  const seededAppOpenwork = arrayValue(data.appOpenwork?.seededFiles);
  const appOpenworkHardDeleteNames = ["server.json", "env.json", "runtime.sqlite"];
  const appOpenworkHardDeleteSurvivors = seededAppOpenwork
    .filter((entry) => appOpenworkHardDeleteNames.includes(String(entry?.name)) && entry?.exists === true)
    .map((entry) => entry.name);
  const appOpenworkMarkerSurvivors = seededAppOpenwork.filter(fileContainsSeed).map((entry) => entry.name);
  const markerSurvivors = seededMarkerSurvivors(data);
  const bootstrapRaw = String(data.bootstrap?.raw ?? "");
  const bootstrap = data.bootstrap ?? {};
  const receipt = data.receipt ?? {};

  witness(ctx, data.userData?.markerExists === false, "%APPDATA%\\com.differentai.openwork lost the seeded userData marker after relaunch", data.userData);
  witness(ctx, data.opencode?.exists === false, "%APPDATA%\\opencode is gone after the nuke", data.opencode);
  witness(ctx, appOpenworkHardDeleteSurvivors.length === 0, "%APPDATA%\\openwork no longer contains seeded server/env/runtime files", data.appOpenwork);
  witness(ctx, appOpenworkMarkerSurvivors.length === 0, "%APPDATA%\\openwork contains no seeded marker/runTag even if clean tokens.json is recreated", data.appOpenwork);
  witness(ctx, markerSurvivors.length === 0, "No seeded marker or runTag survived in post-nuke seeded file probes", markerSurvivors);
  witness(ctx, data.localOpenwork?.exists === true, "%LOCALAPPDATA%\\openwork survives only as the preserved config directory", data.localOpenwork);
  witness(ctx, unexpectedLocal.length === 0, "%LOCALAPPDATA%\\openwork contains only desktop-bootstrap.json", localEntries);
  witness(ctx, data.localOpenwork?.pendingExists === false, ".nuke-pending.json is absent after the unlocked nuke", data.localOpenwork);
  witness(ctx, data.localOpenwork?.envExists === false && data.localOpenwork?.tokensExists === false, "Seeded LOCALAPPDATA env.json and tokens.json were removed", data.localOpenwork);
  witness(ctx, data.bootstrap?.exists === true, "desktop-bootstrap.json still exists", data.bootstrap?.path);
  witness(ctx, bootstrap.parsedOk === true, "desktop-bootstrap.json parses as sanitized JSON", bootstrap);
  witness(ctx, bootstrap.baseUrl === BOOTSTRAP_BASE_URL, "desktop-bootstrap.json keeps baseUrl https://openwork-poc.example.test", bootstrap);
  witness(ctx, bootstrap.requireSignin === true, "desktop-bootstrap.json keeps requireSignin true", bootstrap);
  witness(ctx, bootstrap.brandAppName === BRAND_APP_NAME, `desktop-bootstrap.json keeps brandAppName ${BRAND_APP_NAME}`, bootstrap);
  witness(ctx, bootstrap.containsSecretGrant === false, "desktop-bootstrap.json no longer contains secret-grant", bootstrapRaw);
  witness(ctx, bootstrap.containsSecretToken === false, "desktop-bootstrap.json no longer contains secret-token", bootstrapRaw);
  witness(ctx, bootstrap.containsSeedMarker === false && bootstrap.rawContainsRunTag === false, "desktop-bootstrap.json no longer contains the seeded marker or runTag", bootstrap);
  witness(ctx, bootstrap.hasHandoff === false && bootstrap.hasClaimLinks === false && bootstrap.hasPrepared === false, "desktop-bootstrap.json strips handoff, claimLinks, and prepared", bootstrap);
  witness(ctx, Number(receipt.deletedCount) > 0, "The newest openwork-nuke-receipt JSON has a non-empty deleted[]", data.receipt);
  state.firstReceiptPath = String(data.receipt?.path ?? "");
}

export default {
  id: FLOW_ID,
  title: "Debug nuke wipes Windows local state and relaunches to sanitized sign-in",
  kind: "user-facing",
  requiresApp: false,
  spec: "evals/voiceovers/debug-nuke-fresh-start.md",
  precondition: async (ctx) => {
    const missing = ENV_NAMES.filter((name) => !ctx.env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`debug-nuke-fresh-start requires a running remote Windows packaged app. Missing env: ${missing.join(", ")}. Set OPENWORK_EVAL_WIN_SANDBOX_ID, OPENWORK_EVAL_CDP_URL, and OPENWORK_EVAL_WIN_PROFILE.`);
    }
    if (!/^[a-zA-Z]:\\/.test(WIN_PROFILE)) {
      throw new Error(`OPENWORK_EVAL_WIN_PROFILE must be an absolute Windows profile path, got ${JSON.stringify(WIN_PROFILE)}.`);
    }
    ctx.output("debug-nuke-fresh-start-env", JSON.stringify({
      sandboxId: SANDBOX_ID,
      initialCdpUrl: CDP_URL,
      initialInternalPort: INITIAL_INTERNAL_CDP_PORT,
      optionalInitialPortEnv: process.env.OPENWORK_EVAL_INITIAL_CDP_PORT?.trim() || null,
      winProfile: WIN_PROFILE,
      discoveryPorts: CDP_DISCOVERY_PORTS,
    }, null, 2));
    ctx.cdpBaseUrl = currentCdpUrl;
    await attachApp(ctx, 60_000);
    await waitForAppShell(ctx, "precondition app");
  },
  steps: [
    {
      name: "Frame 1 — A tester's machine is full of real state",
      run: async (ctx) => {
        await ctx.prove("The Windows tester profile has seeded OpenWork, OpenCode, bootstrap, orchestrator, Chromium, and renderer state", {
          voiceover: vo[0],
          action: async () => {
            await attachApp(ctx);
            const openworkSeed = daytonaPowerShellJson(ctx, "seed-openwork-config-and-userdata-state", seedOpenworkConfigAndUserDataScript());
            const bootstrapSeed = daytonaPowerShellJson(ctx, "seed-secret-desktop-bootstrap", seedDesktopBootstrapScript());
            const opencodeSeed = daytonaPowerShellJson(ctx, "seed-opencode-and-orchestrator-state", seedOpencodeAndOrchestratorScript());
            ctx.output("seeded path summary", JSON.stringify({ openworkSeed, bootstrapSeed, opencodeSeed }, null, 2));
            const seededListing = daytonaPowerShellJson(ctx, "seeded-directories-listing", seededDirectoriesListingScript(), { attempts: 2 });
            ctx.output("seeded-directories-listing-json", JSON.stringify(seededListing, null, 2));
            assertSeededDirectoryListing(ctx, seededListing);
            state.rendererSeedSnapshot = await enableRendererState(ctx);
            await navigateToSettings(ctx, "general");
            await ctx.waitForText("Overview of all settings", { timeoutMs: 60_000 });
          },
          assert: async () => {
            const probe = daytonaPowerShellJson(ctx, "seeded-files-probe", fixtureProbeScript(), { attempts: 2 });
            witness(ctx, probe.opencode?.auth === true, "%APPDATA%\\opencode\\auth.json exists", probe.opencode);
            witness(ctx, probe.opencode?.mcpAuth === true, "%APPDATA%\\opencode\\mcp-auth.json exists", probe.opencode);
            witness(ctx, probe.opencode?.db === true, "%APPDATA%\\opencode\\opencode.db exists", probe.opencode);
            witness(ctx, probe.userData?.marker === true, "%APPDATA%\\com.differentai.openwork seeded marker exists", probe.userData);
            witness(ctx, probe.appOpenwork?.server === true && probe.appOpenwork?.env === true && probe.appOpenwork?.tokens === true && probe.appOpenwork?.runtime === true, "%APPDATA%\\openwork seeded server/env/tokens/runtime files exist", probe.appOpenwork);
            witness(ctx, probe.configHome?.env === true && probe.configHome?.tokens === true, "%LOCALAPPDATA%\\openwork env.json and tokens.json exist", probe.configHome);
            witness(ctx, probe.bootstrap?.exists === true, "%LOCALAPPDATA%\\openwork\\desktop-bootstrap.json exists", probe.bootstrap);
            witness(ctx, probe.configHome?.bootstrap === true, "%LOCALAPPDATA%\\openwork\\desktop-bootstrap.json exists in configHome probe", probe.configHome);
            witness(ctx, probe.orchestrator?.auth === true, "profile .openwork\\openwork-orchestrator auth exists", probe.orchestrator);
            witness(ctx, probe.localShareOpencode?.dataMarker === true, "profile .local\\share\\opencode data marker exists", probe.localShareOpencode);
            witness(ctx, probe.cacheOpencode?.cacheMarker === true, "profile .cache\\opencode cache marker exists", probe.cacheOpencode);
            const storage = await ctx.eval(`(() => {
              const pick = ['openwork.preferences', 'openwork.developerMode', 'openwork.den.authToken'];
              const result = {};
              for (const key of pick) result[key] = localStorage.getItem(key);
              result.allOpenworkKeys = Object.keys(localStorage).filter((key) => key.startsWith('openwork.')).sort();
              return result;
            })()`);
            witness(ctx, storage["openwork.developerMode"] === "1", "Renderer localStorage has openwork.developerMode = 1", storage);
            witness(ctx, String(storage["openwork.preferences"] ?? "").includes("hasCompletedOnboarding"), "Renderer localStorage has openwork.preferences with hasCompletedOnboarding", storage);
            witness(ctx, state.rendererSeedSnapshot?.authTokenMatches === true, "Renderer localStorage had the seeded fake openwork.den.authToken immediately after reload", state.rendererSeedSnapshot);
            const redactedStorage = { ...storage, "openwork.den.authToken": storage["openwork.den.authToken"] ? "<seeded>" : null };
            ctx.output("renderer-localStorage-before-nuke", JSON.stringify(redactedStorage, null, 2));
          },
          screenshot: { name: "stateful-machine-before-nuke", requireText: ["Overview of all settings"], rejectText: ["Something went wrong"] },
        });
      },
    },
    {
      name: "Frame 2 — The tester arms the nuke in Debug settings",
      run: async (ctx) => {
        await ctx.prove("Debug settings exposes the Danger zone nuke dialog with delete/survive lists and typed confirmation", {
          voiceover: vo[1],
          action: async () => {
            await attachApp(ctx);
            await openNukeDialog(ctx);
          },
          assert: async () => {
            await ctx.expectText("Danger zone");
            await ctx.expectText("Nuke & fresh start");
            await ctx.expectText("Nuke local state and start fresh?");
            await ctx.expectText("This removes local OpenWork, OpenCode, browser, token, runtime, cache, and orchestrator state on this device.");
            await ctx.expectText("WILL DELETE");
            await ctx.expectText("WILL SURVIVE");
            await ctx.expectText("Keep bootstrap / organization server");
            await ctx.expectText("Type NUKE to confirm");
            await ctx.expectText("Chromium storage cleared: default, persist:openwork-browser");
            await ctx.expectText("Nuke & relaunch");
          },
          screenshot: {
            name: "debug-danger-zone-nuke-dialog",
            requireText: [
              "Nuke local state and start fresh?",
              "This removes local OpenWork, OpenCode, browser, token, runtime, cache, and orchestrator state on this device.",
              "WILL DELETE",
              "WILL SURVIVE",
              "Keep bootstrap / organization server",
              "Type NUKE to confirm",
              "Chromium storage cleared: default, persist:openwork-browser",
              "Nuke & relaunch",
            ],
          },
        });
      },
    },
    {
      name: "Frame 3 — One typed word wipes the machine and the app comes back asking for sign-in",
      run: async (ctx) => {
        await ctx.prove("Typing NUKE executes the cleanup, relaunches Electron, preserves required sign-in, and clears seeded Chromium storage", {
          voiceover: vo[2],
          action: async () => {
            await executeNukeFromDialog(ctx, "first nuke execute-and-relaunch");
            await ctx.waitForText(`Welcome to ${BRAND_APP_NAME}`, { timeoutMs: 90_000 });
          },
          assert: async () => {
            await ctx.expectText(`Welcome to ${BRAND_APP_NAME}`, { timeoutMs: 90_000 });
            await ctx.expectText("Sign in to get started with your workspace.");
            await ctx.expectText(`Sign in to ${BRAND_APP_NAME}`);
            await ctx.expectText("Paste sign-in code");
            const storage = await ctx.eval(`(() => {
              const preferencesRaw = localStorage.getItem('openwork.preferences');
              let preferencesParsed = null;
              try { preferencesParsed = preferencesRaw ? JSON.parse(preferencesRaw) : null; } catch {}
              return {
                preferences: preferencesRaw,
                preferencesParsed,
                developerMode: localStorage.getItem('openwork.developerMode'),
                authToken: localStorage.getItem('openwork.den.authToken'),
                openworkKeys: Object.keys(localStorage).filter((key) => key.startsWith('openwork.')).sort(),
              };
            })()`);
            witness(ctx, storage.authToken === null, "Seeded openwork.den.authToken is gone after Chromium storage clear", storage);
            witness(ctx, storage.preferencesParsed?.seededBy === undefined && storage.preferencesParsed?.runTag === undefined, "openwork.preferences contains no seededBy or runTag after Chromium storage clear", storage);
            witness(ctx, storage.preferencesParsed?.hasCompletedOnboarding !== true, "openwork.preferences does not preserve completed onboarding after Chromium storage clear", storage);
            witness(ctx, storage.developerMode === null, "Seeded openwork.developerMode is gone after Chromium storage clear", storage);
            ctx.output("renderer-localStorage-after-first-nuke", JSON.stringify(storage, null, 2));
          },
          screenshot: {
            name: "fresh-start-forced-signin",
            requireText: [
              `Welcome to ${BRAND_APP_NAME}`,
              "Sign in to get started with your workspace.",
              `Sign in to ${BRAND_APP_NAME}`,
              "Paste sign-in code",
            ],
            rejectText: ["Nuke local state and start fresh?"],
          },
        });
      },
    },
    {
      name: "Frame 4 — No seeded state survived; clean runtime files may be recreated",
      run: async (ctx) => {
        await ctx.prove("Filesystem witnesses show seeded markers are gone, clean runtime credentials may be recreated, sanitized desktop-bootstrap.json survived, and the nuke receipt recorded deleted paths", {
          voiceover: vo[3],
          assert: async () => {
            const roots = daytonaPowerShellJson(ctx, "post-first-nuke-state-roots-probe", postNukeStateRootsProbeScript(), { attempts: 2 });
            const bootstrap = daytonaPowerShellJson(ctx, "post-first-nuke-bootstrap-probe", postNukeBootstrapProbeScript(), { attempts: 2 });
            const receipt = daytonaPowerShellJson(ctx, "post-first-nuke-receipt-probe", latestReceiptProbeScript(), { attempts: 2 });
            const data = { ...roots, bootstrap, receipt };
            ctx.output("post-first-nuke-directory-listing-json", JSON.stringify({ localOpenwork: roots.localOpenwork, opencode: roots.opencode }, null, 2));
            ctx.output("post-first-nuke-witness-json", JSON.stringify(data, null, 2));
            assertPostFirstNuke(ctx, data);
          },
        });
      },
    },
    {
      name: "Frame 5 — A locked database is retried on the next boot",
      run: async (ctx) => {
        await ctx.prove("A locked runtime.sqlite is recorded for retry, then the boot guard removes it after the locker is killed and the app relaunches", {
          voiceover: vo[4],
          action: async () => {
            await attachApp(ctx);
            const lock = daytonaPowerShellJson(ctx, "start-exclusive-runtime-sqlite-lock", lockRuntimeScript());
            state.lockPid = Number(lock.pid) || 0;
            state.lockVerified = lock.locked === true;
            witness(ctx, state.lockVerified, "PowerShell holds an exclusive FileShare.None handle on %LOCALAPPDATA%\\openwork\\runtime.sqlite", lock);
            state.rendererSeedSnapshot = await enableRendererState(ctx, { includePreferences: false });
            await openNukeDialog(ctx);
            await executeNukeFromDialog(ctx, "second nuke with locked runtime.sqlite");
            state.afterLockedNuke = daytonaPowerShellJson(ctx, "after-locked-nuke-pending-or-receipt", lockedStateScript(), { attempts: 2 });
            ctx.output("after-locked-nuke-witness-json", JSON.stringify(state.afterLockedNuke, null, 2));
            state.killResult = daytonaPowerShellJson(ctx, "stop-runtime-sqlite-locker", stopLockerScript(state.lockPid), { allowFailure: true, timeoutMs: 30_000 });
            ctx.output("stop-runtime-sqlite-locker-json", JSON.stringify(state.killResult, null, 2));
            state.unlockProbe = daytonaPowerShellJson(ctx, "verify-runtime-sqlite-lock-released", unlockProbeScript(), { attempts: 2, timeoutMs: 30_000 });
            ctx.output("runtime-sqlite-unlock-probe", JSON.stringify(state.unlockProbe, null, 2));
            state.executableProbe = daytonaPowerShellJson(ctx, "discover-main-openwork-executable-before-out-of-band-boot", discoverMainOpenWorkExecutableScript(), { timeoutMs: 30_000 });
            ctx.output("main-openwork-executable-before-out-of-band-boot-json", JSON.stringify(state.executableProbe, null, 2));
            await bootOutOfBandForLockedRetry(ctx, String(state.executableProbe?.executablePath ?? ""));
            state.afterBootGuard = daytonaPowerShellJson(ctx, "after-boot-guard-locked-path-probe", lockedStateScript(), { attempts: 2 });
            ctx.output("after-boot-guard-witness-json", JSON.stringify(state.afterBootGuard, null, 2));
          },
          assert: async () => {
            const afterLocked = state.afterLockedNuke;
            const afterBoot = state.afterBootGuard;
            const pendingPaths = pendingFilePaths(afterLocked);
            const receiptPaths = receiptPendingPaths(afterLocked);
            state.secondReceiptPath = String(afterLocked?.receiptPath ?? "");
            const hasPendingEvidence =
              (afterLocked?.pendingExists === true && containsPath(pendingPaths, paths.localRuntimeSqlite)) ||
              containsPath(receiptPaths, paths.localRuntimeSqlite);
            witness(ctx, state.lockPid > 0, "The detached locker process has a PID", state.lockPid);
            witness(ctx, afterLocked?.lockedExists === true, "The locked runtime.sqlite still exists immediately after the locked nuke", afterLocked);
            witness(ctx, state.secondReceiptPath.length > 0 && state.secondReceiptPath !== state.firstReceiptPath, "The second nuke wrote a new receipt", { firstReceiptPath: state.firstReceiptPath, secondReceiptPath: state.secondReceiptPath });
            witness(ctx, hasPendingEvidence, "The pending retry file or newest receipt names the locked runtime.sqlite/config root", { pendingPaths, receiptPaths, pendingExists: afterLocked?.pendingExists });
            witness(ctx, state.killResult?.foundBefore === true && state.killResult?.stopped === true && state.killResult?.existsAfter === false, "Stop-Process terminated the detached PowerShell locker", state.killResult);
            witness(ctx, state.unlockProbe?.unlocked === true, "The runtime.sqlite exclusive handle was released before the retry boot", state.unlockProbe);
            witness(ctx, state.executableProbe?.found === true && String(state.executableProbe?.executablePath ?? "").length > 0, "Harness discovered the main OpenWork.exe path before stopping the app", state.executableProbe);
            witness(ctx, state.outOfBandBoot?.createExit === 0 && state.outOfBandBoot?.runExit === 0, "Interactive scheduled task launched a fresh OpenWork process without inherited remote debug port env", state.outOfBandBoot);
            witness(ctx, afterBoot?.pendingExists === false, "After the retry boot, .nuke-pending.json is gone", afterBoot);
            witness(ctx, afterBoot?.lockedExists === false, "After the retry boot, the formerly locked runtime.sqlite is gone", afterBoot);
          },
        });
      },
    },
  ],
};
