import assert from "node:assert/strict";
import { test } from "node:test";
import { checkComposePins } from "./check-compose-pins.mjs";
import {
  readComposePins,
  readDocReferences,
  rewriteComposePins,
  rewriteDocReferences,
  sha256Hex,
} from "./pin-compose-images.mjs";

const OLD_API = "sha256:5ae1fab94ae2badd49ae74649cfb38ca679a7afc7e9ae8926c927553a34caabd";
const OLD_WEB = "sha256:9ca96fb73bc3512852409f1508876e418cd56f6d5187ff4e0c683f5b69a2dda3";
const NEW_API = "sha256:973cb75d435ce7d17011d689a23c2becab021b230dc8cffe78c7b4ea15af443d";
const NEW_WEB = "sha256:b145952d15df51d10fdbe7d689f2399cafa81fdfc55da695befc7659d8b67983";
const MYSQL = "mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb";

const compose = `name: openwork-eval

services:
  mysql:
    image: ${MYSQL}

  den-migrate:
    image: ghcr.io/different-ai/openwork-den-api:0.18.37@${OLD_API}
    restart: "no"

  den:
    image: ghcr.io/different-ai/openwork-den-api:0.18.37@${OLD_API}
    restart: unless-stopped

  web:
    image: ghcr.io/different-ai/openwork-den-web:0.18.37@${OLD_WEB}
    restart: unless-stopped
`;

const OLD_COMMIT = "9f8645ebc482c15ab99c0cf155aabaa411e1ca6a";
const NEW_COMMIT = "50932fa798fb0539bf8c6107b32a29aba83f93c8";
const OLD_CHECKSUM = "69cc7f2666157b7697ebf69b31b0c83887dd99e796c7d956f9ccaab8fa8bf2fc";

const doc = `1. Download the Compose file into an empty directory:

   \`\`\`bash
   curl -fsSLo docker-compose.eval.yml \\
     https://raw.githubusercontent.com/different-ai/openwork/${OLD_COMMIT}/packaging/docker/docker-compose.eval.yml
   printf '%s  %s\\n' \\
     '${OLD_CHECKSUM}' \\
     'docker-compose.eval.yml' | shasum -a 256 --check
   \`\`\`
`;

const readme = `\`\`\`bash
curl -fsSLo docker-compose.eval.yml \\
  https://raw.githubusercontent.com/different-ai/openwork/${OLD_COMMIT}/packaging/docker/docker-compose.eval.yml
printf '%s  %s\\n' \\
  '${OLD_CHECKSUM}' \\
  'docker-compose.eval.yml' | shasum -a 256 --check
\`\`\`
`;

test("readComposePins lists only the OpenWork GHCR images, once per service", () => {
  assert.deepEqual(readComposePins(compose), [
    { image: "openwork-den-api", tag: "0.18.37", digest: OLD_API },
    { image: "openwork-den-api", tag: "0.18.37", digest: OLD_API },
    { image: "openwork-den-web", tag: "0.18.37", digest: OLD_WEB },
  ]);
});

test("rewriteComposePins replaces every occurrence and leaves the rest untouched", () => {
  const rewritten = rewriteComposePins(compose, {
    version: "0.18.45",
    digests: { "openwork-den-api": NEW_API, "openwork-den-web": NEW_WEB },
  });
  assert.equal(
    rewritten,
    compose
      .replaceAll(`openwork-den-api:0.18.37@${OLD_API}`, `openwork-den-api:0.18.45@${NEW_API}`)
      .replaceAll(`openwork-den-web:0.18.37@${OLD_WEB}`, `openwork-den-web:0.18.45@${NEW_WEB}`),
  );
  assert.ok(rewritten.includes(MYSQL), "mysql pin is not an OpenWork image and must stay");
  assert.equal(rewritten.match(/0\.18\.37/g), null);
});

test("rewriteComposePins refuses partial or malformed input", () => {
  assert.throws(
    () => rewriteComposePins(compose, { version: "0.18.45", digests: { "openwork-den-api": NEW_API } }),
    /No digest provided for openwork-den-web/,
  );
  assert.throws(
    () => rewriteComposePins(compose, { version: "v0.18.45", digests: { "openwork-den-api": NEW_API, "openwork-den-web": NEW_WEB } }),
    /Invalid stable version/,
  );
  assert.throws(
    () => rewriteComposePins(compose, { version: "0.18.45", digests: { "openwork-den-api": "sha256:abc", "openwork-den-web": NEW_WEB } }),
    /Invalid digest for openwork-den-api/,
  );
  assert.throws(
    () => rewriteComposePins("services:\n  mysql:\n    image: mysql:8.4\n", { version: "0.18.45", digests: {} }),
    /Expected a pinned openwork-den-api image line/,
  );
});

test("rewriteDocReferences updates the download commit and checksum in both doc shapes", () => {
  const checksum = sha256Hex("new compose content\n");
  for (const text of [doc, readme]) {
    const rewritten = rewriteDocReferences(text, { commit: NEW_COMMIT, checksum });
    assert.deepEqual(readDocReferences(rewritten), { commits: [NEW_COMMIT], checksums: [checksum] });
    assert.equal(rewritten.replace(NEW_COMMIT, OLD_COMMIT).replace(checksum, OLD_CHECKSUM), text);
  }
  assert.throws(() => rewriteDocReferences("no references here\n", { commit: NEW_COMMIT, checksum }), /no compose download URL/);
  assert.throws(() => rewriteDocReferences(doc, { commit: "50932fa", checksum }), /Invalid commit sha/);
});

test("checkComposePins fails on a stale pin and passes once compose and docs agree", () => {
  const docs = [{ path: "doc.mdx", text: doc }, { path: "README.md", text: readme }];

  const stale = checkComposePins({ composeText: compose, docs, releasedVersion: "0.18.45" });
  assert.equal(stale.ok, false);
  assert.match(stale.problems[0], /openwork-den-api is pinned to 0\.18\.37 but the released version is 0\.18\.45/);
  assert.ok(stale.problems.some((problem) => /openwork-den-web is pinned to 0\.18\.37/.test(problem)));
  assert.ok(stale.problems.some((problem) => /documented checksum .* does not match/.test(problem)), "fixture docs carry a checksum of another revision");

  const pinned = rewriteComposePins(compose, {
    version: "0.18.45",
    digests: { "openwork-den-api": NEW_API, "openwork-den-web": NEW_WEB },
  });
  const checksum = sha256Hex(pinned);
  const current = checkComposePins({
    composeText: pinned,
    docs: docs.map(({ path, text }) => ({ path, text: rewriteDocReferences(text, { commit: NEW_COMMIT, checksum }) })),
    releasedVersion: "0.18.45",
  });
  assert.deepEqual(current.problems, []);
  assert.equal(current.ok, true);
});

test("checkComposePins flags docs that point at different compose commits", () => {
  const checksum = sha256Hex(compose);
  const result = checkComposePins({
    composeText: compose,
    docs: [
      { path: "doc.mdx", text: rewriteDocReferences(doc, { commit: OLD_COMMIT, checksum }) },
      { path: "README.md", text: rewriteDocReferences(readme, { commit: NEW_COMMIT, checksum }) },
    ],
    releasedVersion: "0.18.37",
  });
  assert.deepEqual(result.problems, [
    `docs disagree on the compose download commit: ${OLD_COMMIT}, ${NEW_COMMIT}`,
  ]);
});
