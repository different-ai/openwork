import type { Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Synthetic Library data; every record goes through the same APIs as the UI. */
export async function compactLibraryWorld(seed: Seed) {
  const den = await seed.den({
    org: { name: "Fieldnotes Studio", admin: { name: "Library Owner" } },
    mocks: {
      wiki: seed.mock({ allowUnauthenticatedMcp: true }),
      notes: seed.mock(),
    },
  });
  // Listing once initializes starter collections; archive their entries through
  // the supported API so unrelated starter content cannot mask our witnesses.
  const collections = await seed.api(den.admin, "/v1/marketplaces");
  if (!collections.response.ok) throw new Error(`Could not initialize collections: ${collections.text}`);
  for (let cursor = ""; ;) {
    const page = await seed.api(den.admin, `/v1/plugins?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!page.response.ok || !isRecord(page.body) || !Array.isArray(page.body.items)) throw new Error(`Could not list starter entries: ${page.text}`);
    for (const item of page.body.items) {
      if (!isRecord(item) || typeof item.id !== "string") throw new Error("Invalid starter entry.");
      const removed = await seed.api(den.admin, `/v1/plugins/${encodeURIComponent(item.id)}/archive`, { method: "POST", body: "{}" });
      if (!removed.response.ok) throw new Error(`Could not archive starter entry: ${removed.text}`);
    }
    if (typeof page.body.nextCursor !== "string" || !page.body.nextCursor || page.body.items.length === 0) break;
    cursor = page.body.nextCursor;
  }

  // Ten skills and two connectors: more than ten items, so the Library shows its name filter.
  const skills = ["Daily brief", "Decision notes", "Hiring loop", "Meeting agenda", "Onboarding plan", "Release checklist", "Research summary", "Sales call prep", "Support triage", "Weekly review"];
  const descriptions = skills.map((name) => `Prepare a clear ${name.toLowerCase()} from supplied notes`);
  for (const [index, name] of skills.entries()) {
    const skillName = index === 0 ? "daily-brief-instructions" : name.toLowerCase().replaceAll(" ", "-");
    const rawSourceText = `---\nname: ${skillName}\ndescription: ${descriptions[index]}.\n---\n\n# ${name}\n\nOrganize the supplied notes into a short useful document.\n\n1. Read the **supplied notes**.\n2. Keep \`names\` and dates as written.\n\nDo not invent facts.`;
    const created = await seed.api(den.admin, "/v1/plugins", {
      method: "POST", body: JSON.stringify({ name, description: descriptions[index], components: [{ type: "skill", input: { rawSourceText } }] }),
    });
    if (!created.response.ok) throw new Error(`Could not create synthetic skill ${name}: ${created.text}`);
  }
  await seed.orgConnection(den.admin, {
    name: "Team wiki", url: den.mocks.wiki.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true },
  });
  await seed.orgConnection(den.admin, {
    name: "Personal notes", url: den.mocks.notes.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true },
  });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library", headless: true, viewport: { width: 1440, height: 1000 } });
  return { web, skills, descriptions, url: (path: string) => new URL(path, den.ref.webUrl).toString() };
}
