// Builds the certificate chain an inspected enterprise network presents:
// a corporate root, an intermediate that re-signs traffic, and a leaf for the
// workspace host. Cross-platform so the same repro runs on Windows CI.
//
//   node scripts/make-corporate-ca.mjs --out <dir> [--host <name>]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const out = arg("out");
const host = arg("host", "workspace.corporate.test");
if (!out) {
  console.error("usage: make-corporate-ca.mjs --out <dir> [--host <name>]");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const openssl = (args, input) => execFileSync("openssl", args, { input, stdio: ["pipe", "pipe", "pipe"] });
const file = (name) => path.join(out, name);

writeFileSync(file("intermediate.ext"), "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,digitalSignature,cRLSign,keyCertSign\n");
writeFileSync(
  file("leaf.ext"),
  `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
);

openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
  "-keyout", file("root.key"), "-out", file("root.pem"),
  "-subj", "/CN=Corporate Inspection Root CA/O=Corporate IT"]);

openssl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256",
  "-keyout", file("intermediate.key"), "-out", file("intermediate.csr"),
  "-subj", "/CN=Corporate TLS Inspection CA/O=Corporate IT"]);
openssl(["x509", "-req", "-in", file("intermediate.csr"), "-CA", file("root.pem"), "-CAkey", file("root.key"),
  "-CAcreateserial", "-out", file("intermediate.pem"), "-days", "2", "-sha256", "-extfile", file("intermediate.ext")]);

openssl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256",
  "-keyout", file("leaf.key"), "-out", file("leaf.csr"), "-subj", `/CN=${host}/O=Corporate IT`]);
openssl(["x509", "-req", "-in", file("leaf.csr"), "-CA", file("intermediate.pem"), "-CAkey", file("intermediate.key"),
  "-CAcreateserial", "-out", file("leaf.pem"), "-days", "2", "-sha256", "-extfile", file("leaf.ext")]);

// The server presents leaf + intermediate; the root stays out of the chain, so
// only a client that already trusts the root can verify it.
writeFileSync(file("chain.pem"), `${readFileSync(file("leaf.pem"), "utf8")}${readFileSync(file("intermediate.pem"), "utf8")}`);
console.log(out);
