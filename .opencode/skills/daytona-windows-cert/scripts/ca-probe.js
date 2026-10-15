const { X509Certificate } = require("node:crypto");
const tls = require("node:tls");

const needle = (process.env.OPENWORK_TLS_REPRO_CA_MATCH || "OpenWork TLS Repro").toLowerCase();

function countMatchingSubjects(certificates) {
  let count = 0;
  for (const pem of certificates) {
    try {
      const certificate = new X509Certificate(pem);
      if (certificate.subject.toLowerCase().includes(needle)) count += 1;
    } catch {
      // Ignore entries that are not parseable X.509 certificates.
    }
  }
  return count;
}

const system = tls.getCACertificates("system");
const bundled = tls.getCACertificates("default");

const result = {
  systemCount: system.length,
  reproInSystem: countMatchingSubjects(system),
  defaultCount: bundled.length,
  reproInDefault: countMatchingSubjects(bundled),
};

// Optional: also check a PEM bundle such as the app's system-ca-bundle.pem.
// Its subjects are base64-encoded, so a text search cannot find them.
const bundlePath = process.argv[2];
if (bundlePath) {
  const text = require("node:fs").readFileSync(bundlePath, "utf8");
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  result.bundleCount = pems.length;
  result.reproInBundle = countMatchingSubjects(pems);
}

console.log(JSON.stringify(result, null, 2));

if (result.reproInSystem === 0 || result.reproInBundle === 0) {
  process.exitCode = 1;
}
