import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { browserScript } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { browserSecretHandlesWorld } from "./browser-secret-handles.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

const PASSWORD_MANAGER_NAME = "kestrel-keys";

const vaultScript = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/runs.log"
if [ "$1" = "read-locked" ] && [ "$VAULT_SESSION" != "$(cat "$dir/session")" ]; then
  echo "Vault is locked: session \${VAULT_SESSION:-missing} was not accepted" >&2
  exit 5
fi
case "$2" in
  billing/email) cat "$dir/items/email" ;;
  billing/password) cat "$dir/items/password" ;;
  *) echo "No item named $2 in this vault" >&2; exit 3 ;;
esac
`;

const passwordManagerScript = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/runs.log"
cat "$dir/item"
`;

/**
 * The secret-handles world (a signed-in desktop and an https sign-in site only
 * this run's desktop trusts), plus a stand-in for a password manager's command
 * line: a script that prints the site's email or password, and writes down
 * every time it is run. Asked with `read-locked`, it answers only when its
 * session key is in `VAULT_SESSION`, as a locked password manager does. And
 * a contact email no command prints, which the person pastes by hand.
 * Local-only, like the world it builds on.
 */
export async function privateValuesWorld(seed: Seed) {
  const site = await browserSecretHandlesWorld(seed, { DEN_AUDIT_SELF_HOSTED_ENABLED: "true" });
  try {
    const dir = seed.tmpPath("vault");
    mkdirSync(join(dir, "items"), { recursive: true });
    const email = `billing-${randomBytes(6).toString("hex")}@example.test`;
    writeFileSync(join(dir, "items", "email"), `${email}\n`);
    writeFileSync(join(dir, "items", "password"), `${site.password}\n`);
    const vault = join(dir, "vault");
    writeFileSync(vault, vaultScript);
    chmodSync(vault, 0o755);
    const note = join(dir, "billing-note.txt");
    writeFileSync(note, `Billing sign-in: ${email} / ${site.password}\n`);
    const pastedEmail = `contact-${randomBytes(6).toString("hex")}@example.test`;
    const contactNote = join(dir, "contact-note.txt");
    writeFileSync(contactNote, `Billing contact: ${pastedEmail}\n`);
    const vaultSessionKey = `vs_${randomBytes(18).toString("base64url")}`;
    writeFileSync(join(dir, "session"), vaultSessionKey);
    const sessionNote = join(dir, "session-note.txt");
    writeFileSync(sessionNote, `Vault session: ${vaultSessionKey}\n`);
    const notes = { billing: note, contact: contactNote, session: sessionNote };
    const managerDir = join(dir, "password-manager");
    mkdirSync(managerDir, { recursive: true });
    const terminalSecret = `tv_${randomBytes(18).toString("base64url")}`;
    writeFileSync(join(managerDir, "item"), `${terminalSecret}\n`);
    const passwordManager = join(managerDir, PASSWORD_MANAGER_NAME);
    writeFileSync(passwordManager, passwordManagerScript);
    chmodSync(passwordManager, 0o755);
    const engine = resolveEvalEngine();
    const modelAdmin = async (path: string, body: unknown) => {
      const response = await fetch(`${site.model.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`The model witness refused ${path}: HTTP ${response.status}`);
    };
    // The model is scripted and records, for every request it receives, only whether one of these four was in it.
    await modelAdmin("/admin/private-sentinels", { values: [email, site.password, pastedEmail, vaultSessionKey, terminalSecret] });
    return {
      ...site, email, pastedEmail, engine, vaultSessionKey,
      /** The variable the locked vault reads its session key from. */
      vaultSessionEnv: "VAULT_SESSION",
      /**
       * The next turn that says `prompt`: the agent prints a note with its own shell, then answers. The billing note
       * holds the sign-in the vault prints; the contact note holds the email the person pastes; the session note
       * holds the key that unlocks the vault.
       */
      scriptNoteTurn: (prompt: string, reply: string, which: "billing" | "contact" | "session" = "billing") => modelAdmin("/admin/agent-workloads", { workloads: [{
        promptMarker: prompt, latestUserTurn: true, finalReply: reply,
        steps: [{ tool: engine === "v2" ? "shell" : "bash", arguments: { command: `cat '${notes[which]}'`, description: `Read the ${which} note` } }],
      }] }),
      /**
       * The next turn that says `prompt`: the agent runs a password manager's command line in its own terminal (a
       * stand-in with a name no list knows, which prints a value only it holds), then an ordinary command, then answers.
       */
      scriptTerminalTurn: (prompt: string, reply: string) => modelAdmin("/admin/agent-workloads", { workloads: [{
        promptMarker: prompt, latestUserTurn: true, finalReply: reply,
        steps: [
          { tool: engine === "v2" ? "shell" : "bash", arguments: { command: `'${passwordManager}' get password billing`, description: "Read the billing password" } },
          { tool: engine === "v2" ? "shell" : "bash", arguments: { command: `echo terminal-ran-${prompt.split(" ").at(-1)}`, description: "Say the terminal ran" } },
        ],
      }] }),
      /** Every time the stand-in password manager was run, by its arguments. */
      /** The stand-in's own command, as fill_from would name it. */
      passwordManagerCommand: [passwordManager, "get", "password", "billing"],
      passwordManagerName: PASSWORD_MANAGER_NAME,
      passwordManagerRuns: (): string[] => existsSync(join(managerDir, "runs.log")) ? readFileSync(join(managerDir, "runs.log"), "utf8").split("\n").filter(Boolean) : [],
      /** Whether the latest sign-in the site received carried the email the person pasted. */
      latestSignInCarriedPastedEmail: () => site.received().signInEmails.at(-1) === createHash("sha256").update(pastedEmail).digest("hex"),
      /** What the model received for a turn: one entry per request, each saying whether a private value was in it. */
      modelRequests: (prompt: string, sinceIso?: string) => site.model.agentRequests({ promptMarker: prompt, sinceIso }),
      /** Every request the model received since a moment, whatever it was for. */
      modelRequestsSince: (sinceIso: string) => site.model.agentRequests({ sinceIso }),
      /** The conversation as the engine keeps it, read as the app reads it. */
      storedConversation: () => seed.evalIn(site.app, browserScript(async (workspaceId, sessionId, engine) => {
        const port = localStorage.getItem("openwork.server.port");
        const token = localStorage.getItem("openwork.server.token");
        if (!port || !token) return "";
        const mount = engine === "v2" ? "/opencode2/api/session/" : "/opencode/session/";
        const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + mount + encodeURIComponent(sessionId) + "/message?limit=200", { headers: { Authorization: "Bearer " + token } });
        return response.ok ? await response.text() : "";
      }, [site.workspaceId, site.session.sessionId, engine]), { awaitPromise: true, timeoutMs: 30_000 }),
      /** The command that prints an item, as an agent would name it: a program and its arguments. */
      vaultRead: (item: "billing/email" | "billing/password" | "billing/missing") => [vault, "read", item],
      /** The same item from the locked vault: it prints only when the session key is in the command's environment. */
      vaultReadLocked: (item: "billing/email" | "billing/password") => [vault, "read-locked", item],
      /** Every time the vault was run, by its arguments. */
      vaultRuns: (): string[] => existsSync(join(dir, "runs.log")) ? readFileSync(join(dir, "runs.log"), "utf8").split("\n").filter(Boolean) : [],
    };
  } catch (error) {
    await site[Symbol.asyncDispose]();
    throw error;
  }
}

/** What an organization sets for one private-value permission, as Den's Browser tab saves it. */
export type PrivateValueRule = { decision?: "allow" | "ask" | "deny"; allow?: string[]; block?: string[] };

/**
 * The private-values world with the feature already on, and the organization's owner on Everyone's Browser tab in
 * Den beside the person's desktop. The desktop is the owner's own: an organization's rules bind its owner too.
 */
export async function privateValuesAdminWorld(seed: Seed) {
  const world = await privateValuesWorld(seed);
  try {
    await world.turnOnPrivateValues();
    const organizationId = await seededOrganizationId(seed, world.den.admin);
    const web = await seed.web({
      den: world.den, signedInAs: world.den.admin, startPath: "/dashboard/members/teams/everyone?tab=browser",
      headless: true, viewport: { width: 1440, height: 1500 },
    });
    return {
      ...world, web,
      /** The rules Den hands this person's desktop for private values, as a desktop that understands them reads them. */
      async deliveredRules(): Promise<{ action: string; resource: string; effect: string }[]> {
        const read = await seed.api(world.den.admin, "/v1/me/desktop-config", { headers: { "x-openwork-org-id": organizationId, "X-OpenWork-Private-Value-Permissions": "1" } });
        const body: unknown = read.body;
        const permissions: unknown = body && typeof body === "object" ? Reflect.get(body, "agentPermissions") : null;
        const rules: unknown = permissions && typeof permissions === "object" ? Reflect.get(permissions, "rules") : null;
        if (!read.response.ok || !Array.isArray(rules)) throw new Error(`Reading the desktop's rules failed: HTTP ${read.response.status}`);
        return rules.flatMap((rule: unknown) => {
          if (!rule || typeof rule !== "object") return [];
          const action: unknown = Reflect.get(rule, "action");
          const resource: unknown = Reflect.get(rule, "resource");
          const effect: unknown = Reflect.get(rule, "effect");
          return typeof action === "string" && action.startsWith("private_value_") && typeof resource === "string" && typeof effect === "string" ? [{ action, resource, effect }] : [];
        });
      },
      /** The organization's audit events for private-value fills with this action, each as Den returns it, in text. */
      async auditedFills(action: "private_value.filled" | "private_value.fill_declined" | "private_value.fill_refused"): Promise<string[]> {
        const headers = { "x-openwork-org-id": organizationId };
        const listed = await seed.api(world.den.admin, `/v1/audit/operations?limit=100&action=${encodeURIComponent(action)}`, { headers });
        const operations: unknown = listed.body && typeof listed.body === "object" ? Reflect.get(listed.body, "operations") : null;
        if (!listed.response.ok || !Array.isArray(operations)) throw new Error(`Reading the audit log failed: HTTP ${listed.response.status}`);
        const events: string[] = [];
        for (const operation of operations) {
          const id: unknown = operation && typeof operation === "object" ? Reflect.get(operation, "id") : null;
          if (typeof id !== "string") continue;
          const read = await seed.api(world.den.admin, `/v1/audit/operations/${encodeURIComponent(id)}/events?limit=50`, { headers });
          const list: unknown = read.body && typeof read.body === "object" ? Reflect.get(read.body, "events") : null;
          if (!Array.isArray(list)) continue;
          for (const event of list) {
            if (event && typeof event === "object" && Reflect.get(event, "action") === action) events.push(JSON.stringify(event));
          }
        }
        return events;
      },
      /** Puts every private-value permission back to what an organization that set nothing has. */
      async clearRules() {
        const saved = await seed.api(world.den.admin, "/v1/agent-permissions/everyone", {
          method: "PUT", headers: { "x-openwork-org-id": organizationId, "X-OpenWork-Private-Value-Permissions": "1" }, body: JSON.stringify({ settings: {} }),
        });
        if (!saved.response.ok) throw new Error(`Clearing the organization's rules failed: HTTP ${saved.response.status} ${saved.text.slice(0, 300)}`);
      },
    };
  } catch (error) {
    await world[Symbol.asyncDispose]();
    throw error;
  }
}
