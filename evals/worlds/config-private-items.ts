import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@openwork/cdp/cdp";
import { createAdmin, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { isRecord } from "./library.ts";

export async function configPrivateItemsWorld(seed: Seed) {
  const name = "field-notes-migration";
  const admin = { email: "migration-admin@example.test", name: "Migration Admin", password: "SyntheticConfig123!" };
  const source = await seed.den({ org: { name: "Source workspace", admin, members: { creator: { email: "migration-creator@example.test", name: "Skill Creator" } } } });
  const target = await seed.den({ org: { name: "Destination workspace", admin } });
  const creator = source.members.creator;
  if (!creator) throw new Error("The synthetic creator was not provisioned.");
  const created = await seed.api(creator, "/v1/plugins", { method: "POST", body: JSON.stringify({ name, components: [{ type: "skill", input: {
    rawSourceText: `---\nname: ${name}\ndescription: Summarize synthetic field notes.\n---\n\nRead the synthetic field notes.`,
    normalizedPayloadJson: { files: [{ path: "references/guide.md", text: "Synthetic migration guide." }] },
  } }] }) });
  if (created.response.status !== 201) throw new Error(`Could not seed the private plugin: HTTP ${created.response.status}.`);
  const sourceWeb = await seed.web({ den: source, signedInAs: source.admin, startPath: "/dashboard/config", headless: true });
  const targetWeb = await seed.web({ den: target, signedInAs: target.admin, startPath: "/dashboard/config", headless: true });
  const directory = seed.tmpPath("private-config-download");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const base = new URL(sourceWeb.handle.cdpUrl);
  if (base.hostname !== "127.0.0.1" && base.hostname !== "localhost") throw new Error("The proof requires an owned loopback browser.");
  const response = await fetch(new URL("/json/version", base), { signal: AbortSignal.timeout(5_000) });
  const version: unknown = await response.json();
  if (typeof version !== "object" || version === null || !("webSocketDebuggerUrl" in version) || typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("The owned browser did not report its download endpoint.");
  }
  const socket = new URL(version.webSocketDebuggerUrl);
  if (socket.hostname !== base.hostname || socket.port !== base.port) throw new Error("The download endpoint is not the owned browser.");
  return {
    sourceWeb, targetWeb, name,
    async allowDownload() {
      const browser = await connect(socket.href);
      try {
        await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory, eventsEnabled: true });
      } catch (error) {
        browser.close();
        throw error;
      }
      return { async [Symbol.asyncDispose]() { browser.close(); } };
    },
    async joinCreator() {
      const saved = await seed.api(target.admin, "/v1/org");
      const invitations = isRecord(saved.body) && Array.isArray(saved.body.invitations) ? saved.body.invitations : [];
      const invitation = invitations.find((row: unknown) => isRecord(row) && row.email === creator.email && row.status === "pending");
      if (!isRecord(invitation) || typeof invitation.id !== "string") throw new Error("Config did not create the recipient's pending invitation.");
      const link = await seed.api(target.admin, `/v1/invitations/${encodeURIComponent(invitation.id)}/link`);
      if (!link.response.ok || !isRecord(link.body) || typeof link.body.inviteLink !== "string") throw new Error("Could not resolve the imported invitation.");
      const id = new URL(link.body.inviteLink).searchParams.get("invite");
      if (!id) throw new Error("The imported invitation has no join identifier.");
      const member = await createAdmin(target, { email: creator.email, name: "Skill Creator", password: "SyntheticConfig123!" });
      const accepted = await seed.api(member, "/v1/orgs/invitations/accept", { method: "POST", body: JSON.stringify({ id }) });
      if (!accepted.response.ok) throw new Error(`Could not accept the imported invitation: HTTP ${accepted.response.status}.`);
      const web = await seed.web({ den: target, signedInAs: member, startPath: "/dashboard/library", headless: true });
      return {
        web,
        async editSkill(body: string) {
          const listed = await seed.api(member, `/v1/plugins?name=${encodeURIComponent(name)}`);
          const matches = isRecord(listed.body) && Array.isArray(listed.body.items) ? listed.body.items.filter((item: unknown) => isRecord(item) && item.name === name) : [];
          const [match] = matches;
          if (matches.length !== 1 || !isRecord(match) || typeof match.id !== "string") throw new Error("The recipient did not have one imported plugin.");
          const pluginId = match.id;
          const detail = await seed.api(member, `/v1/plugins/${encodeURIComponent(pluginId)}/resolved`);
          const items = isRecord(detail.body) && Array.isArray(detail.body.items) ? detail.body.items : [];
          const skill = items.flatMap((item: unknown) => isRecord(item) && isRecord(item.configObject) ? [item.configObject] : [])
            .find((item: Record<string, unknown>) => item.objectType === "skill" && item.title === name);
          if (!detail.response.ok || !skill || typeof skill.id !== "string") throw new Error("The recipient's plugin does not contain the imported skill.");
          const edit = await seed.api(member, `/v1/config-objects/${encodeURIComponent(skill.id)}/versions`, {
            method: "POST", body: JSON.stringify({ input: { rawSourceText: `---\nname: ${name}\ndescription: Summarize synthetic field notes.\n---\n\n${body}` } }),
          });
          if (!edit.response.ok) throw new Error(`The recipient could not edit the imported skill: HTTP ${edit.response.status}.`);
        },
      };
    },
    async enable() {
      await enableOrganizationCapabilities(seed, source.admin, { configPrivateItems: true });
      await enableOrganizationCapabilities(seed, target.admin, { configPrivateItems: true });
    },
    async download() {
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
      return files.length === 1 ? join(directory, files[0] ?? "") : null;
    },
  };
}
