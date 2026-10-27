import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workshopOauth } from "../worlds/workshop-oauth.ts";
import { record, rows } from "../worlds/workshop-agent.ts";

const test = spec.world(workshopOauth, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 600_000,
});

function payload(result: Record<string, unknown>): Record<string, unknown> {
  const text = rows(result.content).find((part) => part.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Missing MCP result text");
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error("Invalid MCP result body");
  return value;
}

test("two visitors join without passwords, keep one guest across five OAuth connections and keep their files private", async ({ world, user, probe, step, evidence }) => {
  const guests = new Map<"a" | "b", string>();
  await step("before: neither member has authorized any of the five workshop connectors", async () => {
    await user.on(world.webA).reload();
    for (const connection of world.connections) {
      expect((await world.connection("a", connection.id))?.connectedForMe).toBe(false);
      expect((await world.connection("b", connection.id))?.connectedForMe).toBe(false);
      expect(connection.url).toBe(`${world.origin}/${connection.app}/mcp`);
    }
    expect(world.connections).toHaveLength(5);
    expect(new URL(world.origin).hostname).not.toBe(new URL(world.den.ref.webUrl).hostname);
    evidence.recordAssertionEvidence("Both members start with five disconnected per-member OAuth connectors", `Real ${world.hosted ? "hosted" : "local"} automatic-join gateway and Den at different sites; two independent real headless browser profiles; no participant roster, password, model provider or inference request.`, world.connections.length === 5);
    await user.on(world.webA).screenshot();
  });

  for (const person of ["a", "b"] as const) {
    await step(`member ${person.toUpperCase()} consents to five exact app resources with their own account`, async () => {
      const surface = person === "a" ? world.webA : world.webB;
      const browser = user.on(surface);
      const labels: string[] = [];
      for (const connection of world.connections) {
        // Start from Den's real member link and click in-page, not address-bar navigation:
        // the provider request must have a cross-site initiator to exercise SameSite cookies.
        await browser.navigate(connection.signIn);
        await browser.click({ role: "button", label: `Sign in to Workshop ${connection.app}` });
        const text = await probe.eventually(() => probe.on(surface).text(), {
          within: 60_000, label: "the first OAuth GET creates a private guest and waits for explicit consent",
          until: (value) => value.includes("Workshop password") || value.includes("Allow workplace access"),
        });
        expect(text).not.toContain("Workshop password");
        await browser.notSee({ label: "Workshop password" });
        await browser.notSee({ role: "textbox" });
        await browser.notSee({ role: "button", label: "Sign in" });
        await browser.see({ role: "button", label: "Allow workplace access" }, { timeoutMs: 30_000 });
        const guest = text.match(/Workshop guest [1-9][0-9]*/)?.[0];
        expect(guest).toBeTruthy();
        if (!guest) throw new Error("Automatic OAuth consent is missing its guest label");
        if (labels.length > 0) expect(guest).toBe(labels[0]);
        if (person === "b") expect(guest).not.toBe(guests.get("a"));
        labels.push(guest);
        await browser.see({ text: guest });
        // A GET is never approval: the browser is still on consent and Den is disconnected.
        expect((await world.connection(person, connection.id))?.connectedForMe).toBe(false);
        await browser.click({ text: "Connection details" });
        await browser.see({ text: connection.url });
        if (labels.length === 1) await browser.screenshot();
        await browser.click({ role: "button", label: "Allow workplace access" });
        await probe.eventually(() => world.connection(person, connection.id), {
          within: 60_000, label: `member ${person} has a ready ${connection.app} grant`, until: (value) => value?.connectedForMe === true,
        });
        await probe.eventually(() => probe.on(surface).url(), {
          within: 30_000, label: "the browser returns from workshop consent to the different Den site",
          until: (value) => value.startsWith(`${world.den.ref.webUrl}/`) || value.startsWith(`${world.den.ref.apiUrl}/`),
        });
        // Witness the negative half after *every* grant, not just at the end.
        if (person === "a") expect((await world.connection("b", connection.id))?.connectedForMe).toBe(false);
      }
      expect(labels).toHaveLength(5);
      expect(new Set(labels).size).toBe(1);
      const guest = labels[0];
      if (!guest) throw new Error("Missing five-connection guest witness");
      guests.set(person, guest);
      await browser.navigate(`${world.den.ref.webUrl}/dashboard/your-connections`);
      const connected = await Promise.all(world.connections.map((connection) => world.connection(person, connection.id)));
      expect(connected.every((connection) => connection?.connectedForMe === true)).toBe(true);
      evidence.recordAssertionEvidence(`Member ${person.toUpperCase()} keeps one private guest across five explicit OAuth consents`, `Observed labels: ${labels.join(" → ")}. Den performs discovery, registration, PKCE and token exchange for five exact app resources, returning to a different site between every grant. No password field or sign-in input; every GET remained disconnected until Allow was clicked. ${person === "a" ? "B stayed disconnected after each A grant." : `B's ${guests.get("b")} differs from A's ${guests.get("a")}.`}`, connected.every((connection) => connection?.connectedForMe === true) && new Set(labels).size === 1);
      await browser.screenshot();
    });
  }

  let fileId = "";
  const filename = `${world.marker}-private.txt`;
  const content = `Private OAuth-owned document ${world.marker}`;
  await step("after: member A writes and reads their private file through Den's OAuth-backed MCP route", async () => {
    const written = await world.connector("a", "drive", "file_write", { path: filename, content });
    expect(written.isError).not.toBe(true);
    const file = payload(written);
    expect(file.name).toBe(filename);
    expect(typeof file.id).toBe("string");
    fileId = String(file.id);
    const read = await world.connector("a", "drive", "file_read", { item_id: fileId });
    expect(read.isError).not.toBe(true);
    expect(payload(read).content_base64).toBe(Buffer.from(content).toString("base64"));
    const createdBy = record(file.createdBy) ? file.createdBy.user : undefined;
    const driveEmail = record(createdBy) ? createdBy.email : undefined;
    expect(typeof driveEmail).toBe("string");
    const draftResult = await world.connector("a", "outlook", "mail_create_draft", { subject: `${world.marker} identity witness`, body: "Unsent fictional draft", to: ["proof@acme.test"] });
    expect(draftResult.isError).not.toBe(true);
    const draft = payload(draftResult);
    expect(draft.isDraft).toBe(true);
    const sender = record(draft.from) ? draft.from.emailAddress : undefined;
    expect(record(sender) ? sender.address : undefined).toBe(driveEmail);
    expect(record(createdBy) ? createdBy.displayName : undefined).toBe(guests.get("a"));
    await user.on(world.webA).navigate(`${world.origin}/drive`);
    await user.on(world.webA).see({ text: filename }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("A's browser-authorized OAuth grant writes and reads actual private Drive bytes", `search_capabilities → exact discovered execute_capability through /mcp/agent as member A; saved ${filename}; file_read bytes match; same file visible in A's real Drive UI. An unsent Outlook draft's from address equals Drive createdBy.user.email (${driveEmail}), and the creator label matches all five consents. No LLM or direct service-password write.`, written.isError !== true && payload(read).content_base64 === Buffer.from(content).toString("base64"));
    await user.on(world.webA).screenshot();
  });

  await step("the same Drive URL and file ID never reveal member A's private work to member B", async () => {
    const found = await world.connector("b", "drive", "file_find", { query: filename });
    expect(found.isError).not.toBe(true);
    expect(rows(payload(found).value)).toHaveLength(0);
    const denied = await world.connector("b", "drive", "file_read", { item_id: fileId });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain(Buffer.from(content).toString("base64"));
    await user.on(world.webB).navigate(`${world.origin}/drive`);
    await user.on(world.webB).see({ text: "Northwind-pilot-brief.docx" }, { timeoutMs: 30_000 });
    await user.on(world.webB).notSee({ text: filename });
    const own = await world.connector("a", "drive", "file_find", { query: filename });
    expect(rows(payload(own).value)).toHaveLength(1);
    evidence.recordAssertionEvidence("B's separate OAuth grant cannot list or read A's file while A retains it", "Identical connector resource and Drive browser URL: B file_find returns zero, B file_read of A's actual ID returns isError, B's real Drive shows its own seeded brief and no A file; A file_find still returns one. Fictional-service OAuth isolation through actual Den and browsers, not paid-agent or production-provider coverage.", denied.isError === true && rows(payload(found).value).length === 0 && rows(payload(own).value).length === 1);
    await user.on(world.webB).screenshot();
  });
});
