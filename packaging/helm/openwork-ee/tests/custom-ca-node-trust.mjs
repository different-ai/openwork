import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "openwork-custom-ca-"));
const caKey = join(tmp, "ca.key");
const caCert = join(tmp, "ca.crt");
const serverKey = join(tmp, "server.key");
const serverCsr = join(tmp, "server.csr");
const serverCert = join(tmp, "server.crt");
const opensslConfig = join(tmp, "openssl.cnf");

function runOpenSsl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`openssl ${args.join(" ")} failed\n${result.stderr}`);
  }
}

function clientEnvironment(caPath) {
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (caPath) {
    env.NODE_EXTRA_CA_CERTS = caPath;
  }
  return env;
}

function runClient(url, caPath) {
  const clientSource = `
const https = require("node:https");
https.get(process.argv[1], (response) => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => { body += chunk; });
  response.on("end", () => {
    if (response.statusCode === 200 && body === "openwork-custom-ca-ok") {
      console.log(body);
      process.exit(0);
    }
    console.error(\`unexpected response: \${response.statusCode} \${body}\`);
    process.exit(1);
  });
}).on("error", (error) => {
  console.error(error.code || error.message);
  process.exit(2);
});
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", clientSource, url], {
      env: clientEnvironment(caPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

try {
  writeFileSync(
    opensslConfig,
    `[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
`,
  );

  runOpenSsl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=OpenWork Test CA", "-keyout", caKey, "-out", caCert]);
  runOpenSsl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverCsr, "-config", opensslConfig]);
  runOpenSsl(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", serverCert, "-days", "1", "-extensions", "v3_req", "-extfile", opensslConfig]);

  const server = createServer(
    {
      key: readFileSync(serverKey),
      cert: readFileSync(serverCert),
    },
    (_request, response) => {
      response.end("openwork-custom-ca-ok");
    },
  );

  await listen(server);
  const address = server.address();
  const url = `https://127.0.0.1:${address.port}/`;

  try {
    const withoutCustomCa = await runClient(url);
    if (withoutCustomCa.status === 0) {
      throw new Error("Strict TLS unexpectedly trusted the private CA without NODE_EXTRA_CA_CERTS");
    }

    const withCustomCa = await runClient(url, caCert);
    if (withCustomCa.status !== 0) {
      throw new Error(`Strict TLS did not trust NODE_EXTRA_CA_CERTS=${caCert}\n${withCustomCa.stderr}`);
    }

    console.log(`Strict TLS without NODE_EXTRA_CA_CERTS: rejected (${withoutCustomCa.stderr.trim()})`);
    console.log(`Strict TLS with NODE_EXTRA_CA_CERTS=${caCert}: accepted (${withCustomCa.stdout.trim()})`);
    console.log("Focused runtime trust check passed; this verifies Node's strict TLS trust path without starting MySQL.");
  } finally {
    await close(server);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
