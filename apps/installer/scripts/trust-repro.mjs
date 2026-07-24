// Drives the compiled installer's real /api/resolve-link route against a host
// served with a corporate CA chain, the way an inspected enterprise network
// presents it. Prints the outcome so CI can assert on it.
//
//   node scripts/trust-repro.mjs --installer <path> --certs <dir> [--expect resolved|tls-untrusted]
//
// Nothing in the chain is in Bun's bundled roots, so the installer resolves the
// link only when it picks the corporate root up from an OS trust source.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const installerPath = arg("installer");
const certsDir = arg("certs");
const expected = arg("expect");
if (!installerPath || !certsDir) {
  console.error("usage: trust-repro.mjs --installer <path> --certs <dir> [--expect resolved|tls-untrusted]");
  process.exit(2);
}

const den = createServer(
  { cert: readFileSync(`${certsDir}/chain.pem`), key: readFileSync(`${certsDir}/leaf.key`) },
  (req, res) => {
    const url = new URL(req.url, "https://workspace.invalid");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/install-config") {
      res.end(JSON.stringify({
        appName: "Corporate Work",
        clientName: "Corporate",
        webUrl: "https://workspace.example.com",
        apiUrl: "https://api.workspace.example.com",
        requireSignin: true,
        logoUrl: null,
      }));
      return;
    }
    if (url.pathname === "/v1/app-version") {
      res.end(JSON.stringify({ latestAppVersion: "0.18.0" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  },
);

const denPort = await new Promise((resolve) => {
  den.listen(0, "127.0.0.1", () => resolve(den.address().port));
});

const installer = spawn(installerPath, [], {
  env: { ...process.env, OPENWORK_INSTALLER_UI: "manual" },
  stdio: ["ignore", "pipe", "pipe"],
});

let installerOutput = "";
installer.stdout.setEncoding("utf8");
installer.stderr.setEncoding("utf8");
installer.stdout.on("data", (chunk) => { installerOutput += chunk; });
installer.stderr.on("data", (chunk) => { installerOutput += chunk; });

function shutdown(code) {
  installer.kill();
  den.close();
  process.exit(code);
}

const uiUrl = await new Promise((resolve) => {
  const deadline = Date.now() + 60_000;
  const poll = setInterval(() => {
    const match = installerOutput.match(/UI ready at (\S+)/);
    if (match) {
      clearInterval(poll);
      resolve(match[1]);
    } else if (Date.now() > deadline || installer.exitCode !== null) {
      clearInterval(poll);
      resolve(null);
    }
  }, 250);
});

if (!uiUrl) {
  console.error("installer UI never became ready:");
  console.error(installerOutput);
  shutdown(2);
}

// The served page carries the API token, same as the real UI.
const token = (await (await fetch(uiUrl)).text()).match(/[0-9a-f]{32}/)?.[0];
if (!token) {
  console.error("could not read the installer API token from the served page");
  shutdown(2);
}

const response = await fetch(`${uiUrl}api/resolve-link`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-installer-token": token },
  body: JSON.stringify({ installLink: `https://localhost:${denPort}/v1/install-config?token=abcDEF12` }),
});
const body = await response.json();

const outcome = response.ok ? "resolved" : body.error === "install_link_tls_untrusted" ? "tls-untrusted" : `other:${body.error}`;
console.log(`outcome: ${outcome}`);
if (body.message) console.log(`message: ${body.message}`);
if (body.trustSources) console.log(`trustSources: ${body.trustSources}`);
const diagnostics = installerOutput.match(/OS trust store: .*/g);
if (diagnostics) console.log(`diagnostics: ${diagnostics.at(-1)}`);

if (expected && outcome !== expected) {
  console.error(`FAILED: expected ${expected}, got ${outcome}`);
  shutdown(1);
}
console.log(expected ? `OK: ${outcome} as expected` : "done");
shutdown(0);
