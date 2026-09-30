import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { originTransform, originReplacements, replaceOrigins, templateOrigins } from "../src/origins.mjs";

test("a live snapshot's origins map to independent clones, including encoded handoffs and split UTF-8", async () => {
  const first = { den: "https://den-11111111111111111111111111111111.preview.openwork.software" };
  const second = { den: "https://den-22222222222222222222222222222222.preview.openwork.software" };
  const payload = JSON.stringify({ url: templateOrigins.den, handoff: encodeURIComponent(`${templateOrigins.den}/api/den`), unicode: "🌍 café" });
  const bytes = Buffer.from(payload);
  const chunks = [];
  for await (const chunk of Readable.from([...bytes].map((byte) => Buffer.from([byte]))).pipe(originTransform(originReplacements(templateOrigins, first)))) chunks.push(chunk);
  const output = Buffer.concat(chunks).toString();
  assert.deepEqual(JSON.parse(output), { url: first.den, handoff: encodeURIComponent(`${first.den}/api/den`), unicode: "🌍 café" });
  assert.equal(replaceOrigins(output, originReplacements(first, templateOrigins)), payload);
  assert.ok(!replaceOrigins(payload, originReplacements(templateOrigins, second)).includes(new URL(first.den).hostname));
});

test("the desktop viewer has its own template origin, distinct from every other service", () => {
  assert.equal(new URL(templateOrigins.desktop).hostname, `desktop-${"0".repeat(32)}.preview.openwork.software`);
  assert.equal(new Set(Object.values(templateOrigins)).size, Object.keys(templateOrigins).length);
});
