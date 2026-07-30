import { spawn } from "node:child_process";

const COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_CHARS = 8 * 1024 * 1024;
const WINDOWS_CERT_BEGIN = "-----OPENWORK-CERTIFICATE-----";
const WINDOWS_CERT_END = "-----END-OPENWORK-CERTIFICATE-----";
const PEM_CERT_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * @typedef {(command: string, args: string[], windowsHide: boolean) => Promise<string | null>} SystemCaCommandRunner
 */

/**
 * @typedef {Object} SystemCaSource
 * @property {string} name
 * @property {number} count
 */

/**
 * @typedef {Object} SystemCaBundle
 * @property {string[]} certificates
 * @property {SystemCaSource[]} sources
 */

/**
 * @typedef {Object} SystemCaPlatformLoader
 * @property {string} name
 * @property {() => Promise<string[]>} load
 */

/**
 * @typedef {Object} SystemCaLoaders
 * @property {() => string[]} runtime
 * @property {SystemCaPlatformLoader} platform
 */

/**
 * @param {Iterable<string>} certs
 * @returns {string[]}
 */
export function dedupeCertificates(certs) {
  const seen = new Set();
  const out = [];
  for (const cert of certs) {
    const trimmed = String(cert ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
export function pemFromBase64(value) {
  const base64 = value.replace(/\s+/g, "");
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return null;
  }
  const lines = base64.match(/.{1,64}/g);
  if (!lines) return null;
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * @param {string} output
 * @returns {string[]}
 */
export function parseWindowsPowerShellCertificates(output) {
  const certs = [];
  const pattern = new RegExp(`${WINDOWS_CERT_BEGIN}\\s*([A-Za-z0-9+/=\\r\\n]+?)\\s*${WINDOWS_CERT_END}`, "g");
  for (const match of output.matchAll(pattern)) {
    const pem = pemFromBase64(match[1] ?? "");
    if (pem) certs.push(pem);
  }
  return dedupeCertificates(certs);
}

/**
 * @param {string} output
 * @returns {string[]}
 */
export function parseDarwinSecurityCertificates(output) {
  const certs = [];
  for (const match of output.matchAll(PEM_CERT_PATTERN)) {
    certs.push(match[0]);
  }
  return dedupeCertificates(certs);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {boolean} windowsHide
 * @returns {Promise<string | null>}
 */
export function runCommand(command, args, windowsHide) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide });
    } catch {
      resolve(null);
      return;
    }

    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, COMMAND_TIMEOUT_MS);

    /** @param {string | null} value */
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      const next = `${output}${String(chunk)}`;
      if (next.length > OUTPUT_LIMIT_CHARS) {
        child.kill();
        finish(null);
        return;
      }
      output = next;
    });
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code === 0 ? output : null));
  });
}

/**
 * @param {SystemCaCommandRunner} [commandRunner]
 * @returns {Promise<string[]>}
 */
export async function loadWindowsSystemCertificates(commandRunner = runCommand) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$stores = @('Cert:\\LocalMachine\\Root', 'Cert:\\LocalMachine\\CA', 'Cert:\\CurrentUser\\Root', 'Cert:\\CurrentUser\\CA')
foreach ($store in $stores) {
  Get-ChildItem -Path $store -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.RawData) {
      '${WINDOWS_CERT_BEGIN}'
      [Convert]::ToBase64String($_.RawData)
      '${WINDOWS_CERT_END}'
    }
  }
}
`;
  const output = await commandRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], true);
  return output ? parseWindowsPowerShellCertificates(output) : [];
}

// Admin-controlled keychains only. `find-certificate` ignores trust settings, so
// including the user-writable login keychain would let any local process widen
// what the desktop trusts; user-domain roots go through NODE_EXTRA_CA_CERTS.
export const DARWIN_KEYCHAINS = [
  "/Library/Keychains/System.keychain",
  "/System/Library/Keychains/SystemRootCertificates.keychain",
];

/**
 * @param {SystemCaCommandRunner} [commandRunner]
 * @returns {Promise<string[]>}
 */
export async function loadDarwinSystemCertificates(commandRunner = runCommand) {
  const output = await commandRunner("security", ["find-certificate", "-a", "-p", ...DARWIN_KEYCHAINS], false);
  return output ? parseDarwinSecurityCertificates(output) : [];
}

/**
 * @param {NodeJS.Platform} platform
 * @param {SystemCaCommandRunner} [commandRunner]
 * @returns {SystemCaPlatformLoader}
 */
export function systemPlatformCertificateLoader(platform = process.platform, commandRunner = runCommand) {
  if (platform === "win32") return { name: "windows-cert-stores", load: () => loadWindowsSystemCertificates(commandRunner) };
  if (platform === "darwin") return { name: "macos-keychains", load: () => loadDarwinSystemCertificates(commandRunner) };
  return { name: "platform-stores", load: async () => [] };
}

/**
 * Every source is additive. Returning the runtime list as soon as it is
 * non-empty skips the thorough platform enumeration, which is where corporate
 * roots often live on managed Windows and macOS machines.
 *
 * @param {SystemCaLoaders} loaders
 * @returns {Promise<SystemCaBundle>}
 */
export async function resolveSystemCaBundle(loaders) {
  let runtimeCerts = [];
  try {
    runtimeCerts = loaders.runtime();
  } catch {
    runtimeCerts = [];
  }
  const platformCerts = await loaders.platform.load().catch(() => []);

  return {
    certificates: dedupeCertificates([...runtimeCerts, ...platformCerts]),
    sources: [
      { name: "runtime", count: runtimeCerts.length },
      { name: loaders.platform.name, count: platformCerts.length },
    ],
  };
}

/**
 * @param {SystemCaSource[]} sources
 * @returns {string}
 */
export function summarizeSystemCaSources(sources) {
  if (sources.length === 0) return "no OS trust sources returned certificates";
  return sources.map((source) => `${source.name}=${source.count}`).join(" ");
}
