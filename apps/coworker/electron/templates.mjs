import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { coworkerTemplateSchema } from "@openwork/types/coworker-template";
import { getCoworker, listCoworkers, readCoworkerFile, slugifyCoworkerName } from "./coworkers.mjs";

const receiptsSchema = z.record(z.string(), z.object({ slug: z.string(), versionId: z.string() }));

export function templateScope(session, userEmail) {
  if (typeof userEmail !== "string" || !userEmail.trim()) throw new Error("Sign in again before adding your assigned coworkers.");
  const base = new URL(session.baseUrl);
  return createHash("sha256").update(JSON.stringify([base.origin + base.pathname.replace(/\/+$/, ""), session.orgId, userEmail.trim().toLowerCase()])).digest("hex");
}

/** Serialize installations across windows; keep a receipt even after a coworker is retired. */
export function createTemplateInstaller(coworkersDir, create) {
  let pending = Promise.resolve();
  const receiptsPath = path.join(coworkersDir, ".template-receipts.json");
  async function load() {
    try { return receiptsSchema.parse(JSON.parse(await readFile(receiptsPath, "utf8"))); }
    catch (error) { if (error.code === "ENOENT") return {}; throw new Error("The record of added coworkers could not be read. Your existing work has been kept."); }
  }
  async function persist(receipts) {
    await mkdir(coworkersDir, { recursive: true });
    const temporary = `${receiptsPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
    await rename(temporary, receiptsPath);
  }
  async function run({ scope, items, installIds = [], automatic = false, isCurrent = () => true }) {
    const receipts = await load();
    const existing = await listCoworkers(coworkersDir);
    const created = [];
    const result = [];
    for (const item of items) {
      if (!isCurrent()) throw new Error("The OpenWork account changed. Refresh your team.");
      const template = coworkerTemplateSchema.parse(item.template);
      const origin = createHash("sha256").update(`${scope}:${item.id}`).digest("hex");
      // The origin is written when the home is created, closing the window between
      // creation and the receipt if the app was interrupted during registration.
      const recovered = existing.find((entry) => entry.templateOrigin === origin);
      if (!receipts[origin] && recovered) {
        receipts[origin] = { slug: recovered.slug, versionId: recovered.templateVersion };
        await persist(receipts);
      }
      if (!receipts[origin] && (installIds.includes(item.id) || (automatic && item.assigned && template.provisioning === "automatic"))) {
        let name = template.name;
        // Slugs are capped at 60 characters. Reserve room for the suffix so a
        // long duplicate name cannot keep producing the same truncated slug.
        for (let suffix = 2; existing.some((entry) => entry.slug === slugifyCoworkerName(name)); suffix += 1) name = `${template.name.slice(0, 48)} ${suffix}`;
        const coworker = await create({
          name, role: template.role, mission: template.mission, avatarColor: template.avatarColor, avatarGlasses: template.avatarGlasses,
          templateInstructions: template.instructions, templateOrigin: origin, templateVersion: item.versionId,
          firstNote: "Added from an OpenWork Connect coworker template. My memories and working documents start here.",
        });
        existing.push(coworker);
        created.push(coworker);
        receipts[origin] = { slug: coworker.slug, versionId: item.versionId };
        await persist(receipts);
      }
      const receipt = receipts[origin];
      result.push({ ...item, installed: Boolean(receipt), slug: receipt?.slug ?? null, updateAvailable: Boolean(receipt && receipt.versionId !== item.versionId) });
    }
    return { items: result, created };
  }
  return (input) => {
    const result = pending.then(() => run(input));
    pending = result.catch(() => undefined);
    return result;
  };
}

/** Export only the starting profile and expressly reusable instructions. */
export async function exportCoworkerTemplate(coworkersDir, slug) {
  const coworker = await getCoworker(coworkersDir, slug);
  let instructions = "";
  try { instructions = await readCoworkerFile(coworkersDir, slug, "template-instructions.md"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return coworkerTemplateSchema.parse({
    kind: "coworker", schemaVersion: 1, name: coworker.name, role: coworker.role || "Coworker",
    description: coworker.role || "A prepared coworker", mission: coworker.mission || "Help with the work you are given.",
    instructions, avatarColor: coworker.avatarColor, avatarGlasses: coworker.avatarGlasses, provisioning: "optional",
  });
}
