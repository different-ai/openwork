import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { expect } from "vitest";
import { localMysqlIsRunning, needs, server, test } from "@openwork/testkit";

// Reproduces Sentry DEN-API-Z (config object insert) and DEN-API-1K (version
// update): a SKILL.md whose derived search_text projection exceeds the MySQL
// TEXT column's 65,535-byte cap failed the whole write with errno 1406 on
// strict-mode MySQL/Vitess and surfaced as HTTP 500.
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOverride = Boolean(process.env.OPENWORK_EVAL_MYSQL_URL?.trim());
const mysqlOpen = !localPlacement || mysqlOverride || (await localMysqlIsRunning());
const title = !e2eTestsEnabled
  ? "oversized multibyte skill projection skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !mysqlOpen
    ? "oversized multibyte skill projection skipped — needs MySQL on 127.0.0.1:3306"
    : "an oversized multibyte SKILL.md saves cleanly and only its derived search projection is clamped";

const MYSQL_TEXT_MAX_BYTES = 65_535;
const PROJECTION_TEXT_MAX_BYTES = 60_000;
// Accented characters and em-dashes make byte length exceed character count,
// matching the production payloads (French skill body, CJK threshold probe).
const SENTENCE =
  "Orchestre le développement complet d'apps mobiles — idée, étude de marché, validation, croissance, déploiement. 大小阈值测试。";

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function buildSkillMarkdown(name: string, headline: string, targetBytes: number) {
  let markdown = `---\nname: ${name}\ndescription: Skill volumineux multi-octets qui prouve la limite de search_text.\n---\n\n# ${headline}\n\n`;
  while (utf8Bytes(markdown) < targetBytes) markdown += SENTENCE;
  return markdown.trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemOf(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body.item)) throw new Error(`Response had no item: ${JSON.stringify(body).slice(0, 300)}`);
  return body.item;
}

async function activeOrganizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Resolving the provisioned organization failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  }
  return id;
}

test.skipIf(!e2eTestsEnabled || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  await using den = await server({
    place,
    org: { name: `SearchText Overflow ${unique}` },
  });
  const admin = den.admin;
  const orgId = await activeOrganizationId(admin);
  const orgHeaders = {
    authorization: `Bearer ${admin.token}`,
    "x-openwork-org-id": orgId,
  };

  // Large multibyte bodies over the Daytona preview proxy need a wider, still
  // bounded, per-request budget than the denFetch default.
  const largeRequestSignal = () => AbortSignal.timeout(120_000);

  // 120 KB > 65,535-byte TEXT cap: this exact insert failed with errno 1406 (DEN-API-Z).
  const skillName = `grand-skill-multioctets-${unique}`;
  const skillV1 = buildSkillMarkdown(skillName, "Orchestrateur V1", 120_000);
  const created = await denFetch(admin, "/v1/config-objects", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({ type: "skill", sourceMode: "cloud", input: { rawSourceText: skillV1 } }),
    signal: largeRequestSignal(),
  });
  expect(created.response.status).toBe(201);
  const createdItem = itemOf(created.body);
  const configObjectId = typeof createdItem.id === "string" ? createdItem.id : "";
  expect(configObjectId).toMatch(/^cob_/);
  evidence.recordAssertionEvidence(
    "An oversized multibyte skill can be created",
    `POST /v1/config-objects with a ${utf8Bytes(skillV1)}-byte SKILL.md returned HTTP ${created.response.status}; pre-fix this failed HTTP 500 with errno 1406 (DEN-API-Z).`,
    created.response.status === 201,
  );

  // 200 KB update: this exact version create failed with errno 1406 (DEN-API-1K).
  const skillV2 = buildSkillMarkdown(skillName, "Orchestrateur V2", 200_000);
  const versioned = await denFetch(admin, `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions`, {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({ input: { rawSourceText: skillV2 }, reason: "spec: oversized multibyte update" }),
    signal: largeRequestSignal(),
  });
  expect(versioned.response.status).toBe(201);
  evidence.recordAssertionEvidence(
    "An oversized multibyte version update saves",
    `POST /v1/config-objects/:id/versions with a ${utf8Bytes(skillV2)}-byte SKILL.md returned HTTP ${versioned.response.status}; pre-fix this failed HTTP 500 with errno 1406 (DEN-API-1K).`,
    versioned.response.status === 201,
  );

  const detail = await denFetch(admin, `/v1/config-objects/${encodeURIComponent(configObjectId)}`, {
    headers: orgHeaders,
    signal: largeRequestSignal(),
  });
  expect(detail.response.status).toBe(200);
  const item = itemOf(detail.body);
  const searchText = typeof item.searchText === "string" ? item.searchText : "";
  const searchTextBytes = utf8Bytes(searchText);
  expect(searchText.startsWith(skillName)).toBe(true);
  expect(searchTextBytes).toBeLessThanOrEqual(PROJECTION_TEXT_MAX_BYTES);
  expect(searchTextBytes).toBeGreaterThan(PROJECTION_TEXT_MAX_BYTES - 8);
  evidence.recordAssertionEvidence(
    "Only the derived search projection is clamped",
    `config_object.searchText holds ${searchTextBytes} UTF-8 bytes: within the ${PROJECTION_TEXT_MAX_BYTES}-byte projection budget, under the ${MYSQL_TEXT_MAX_BYTES}-byte MySQL TEXT cap, and cut on a code-point boundary.`,
    searchTextBytes <= PROJECTION_TEXT_MAX_BYTES && searchTextBytes > PROJECTION_TEXT_MAX_BYTES - 8,
  );

  // Negative half: the immutable version keeps the full source; nothing the
  // user wrote is truncated.
  const latestVersion = isRecord(item.latestVersion) ? item.latestVersion : null;
  const storedSource = latestVersion && typeof latestVersion.rawSourceText === "string" ? latestVersion.rawSourceText : "";
  expect(storedSource).toBe(skillV2);
  evidence.recordAssertionEvidence(
    "The stored SKILL.md source is byte-identical",
    `latestVersion.rawSourceText round-trips all ${utf8Bytes(skillV2)} bytes of the update; clamping never touches the source of truth.`,
    storedSource === skillV2,
  );

  // Negative half: a small skill's projection is not altered by the clamp.
  const smallName = `petit-skill-${unique}`;
  const smallBody = "Corps compact avec accents — été, déjà, très.";
  const smallSkill = `---\nname: ${smallName}\ndescription: Petit skill témoin.\n---\n\n${smallBody}`;
  const smallCreated = await denFetch(admin, "/v1/config-objects", {
    method: "POST",
    headers: orgHeaders,
    body: JSON.stringify({ type: "skill", sourceMode: "cloud", input: { rawSourceText: smallSkill } }),
  });
  expect(smallCreated.response.status).toBe(201);
  const smallItem = itemOf(smallCreated.body);
  const smallSearchText = typeof smallItem.searchText === "string" ? smallItem.searchText : "";
  expect(smallSearchText).toBe([smallName, "Petit skill témoin.", smallBody].join("\n"));
  evidence.recordAssertionEvidence(
    "Small skills keep their full projection",
    "A compact skill's searchText remains the exact name/description/body join; the clamp only affects oversized values.",
    smallSearchText === [smallName, "Petit skill témoin.", smallBody].join("\n"),
  );
});
