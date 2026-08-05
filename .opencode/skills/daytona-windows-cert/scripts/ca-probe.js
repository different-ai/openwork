const { X509Certificate } = require("node:crypto");
const tls = require("node:tls");

const needle = (process.env.MICX_TLS_REPRO_CA_MATCH || "Micx TLS Repro").toLowerCase();

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

console.log(JSON.stringify(result, null, 2));

if (result.reproInSystem === 0) {
  process.exitCode = 1;
}
