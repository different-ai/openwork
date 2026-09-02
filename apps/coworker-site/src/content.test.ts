import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD,
  FORBIDDEN_PHRASES,
  GET_STARTED,
  HERO,
  MEMORY,
  NEEDS_YOU,
  PLATFORM,
  RESPONSIBILITIES,
  SITE,
  allClaims,
} from "./content.ts";

test("every product claim names where in the product it is true", () => {
  const claims = allClaims();
  assert.ok(claims.length >= 12, `expected a full page of claims, got ${claims.length}`);
  for (const claim of claims) {
    assert.ok(claim.text.trim().length > 20, `claim is too thin: ${claim.text}`);
    if (claim.planned) {
      assert.match(claim.source, /^plans\//, `a planned statement must be sourced to the product plan: ${claim.text}`);
      assert.match(claim.text, /direction|toward|next|over time/i, `a planned statement must read as direction, not as shipped: ${claim.text}`);
      continue;
    }
    assert.match(
      claim.source,
      /(apps\/coworker|packages\/|ee\/apps\/den-api|ee\/apps\/landing\/app\/pricing|@openwork\/)/,
      `claim needs a product source, got "${claim.source}" for: ${claim.text}`,
    );
  }
});

test("only one statement on the page is about direction, and it says so", () => {
  const planned = allClaims().filter((claim) => claim.planned);
  assert.equal(planned.length, 1);
  assert.match(planned[0]!.text, /today the app is where they live/);
});

test("copy never promises what the product cannot do", () => {
  const everything = JSON.stringify({ HERO, MEMORY, NEEDS_YOU, RESPONSIBILITIES, PLATFORM, GET_STARTED, CLOUD }).toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    assert.equal(everything.includes(phrase), false, `forbidden phrase present: "${phrase}"`);
  }
});

test("placement copy keeps local and cloud promises distinct and truthful", () => {
  const local = RESPONSIBILITIES.placements.find((placement) => placement.name === "This Mac");
  const cloud = RESPONSIBILITIES.placements.find((placement) => placement.name === "OpenWork Cloud");
  assert.ok(local && cloud);
  assert.match(local.points.join(" "), /while Open Coworker is open/);
  assert.match(local.points.join(" "), /latest one is recovered/);
  assert.match(cloud.points.join(" "), /even when your Mac is off/);
  assert.match(cloud.points.join(" "), /Cannot read the coworker's local files or memory/);
  assert.match(CLOUD.cloud.points.map((point) => point.text).join(" "), /even when your Mac is off/);
  assert.equal(CLOUD.cloud.cta.href.startsWith("https://app.openworklabs.com?mode=sign-up"), true, "the Cloud CTA is the real sign-up");
});

test("get-started is honest about distribution", () => {
  assert.match(GET_STARTED.status, /no packaged download yet/);
  assert.ok(GET_STARTED.commands.some((command) => command.includes("@openwork/coworker dev")));
  assert.ok(GET_STARTED.commands[0]?.startsWith(`git clone ${SITE.repository}`));
});
