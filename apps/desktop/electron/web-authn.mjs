import { execFileSync } from "node:child_process";

/** @typedef {(command: string, args: string[], options: import("node:child_process").ExecFileSyncOptionsWithStringEncoding) => string} CommandRunner */
/** @type {CommandRunner} */
const runStringCommand = (command, args, options) => execFileSync(command, args, options);

/** Only enable Touch ID for an app whose signed entitlement grants its own group. */
/** @param {{ executable: string, appId: string, run?: CommandRunner }} options */
export function signedWebAuthnGroup({ executable, appId, run = runStringCommand }) {
  try {
    const xml = run("codesign", ["-d", "--entitlements", "-", "--xml", executable], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!xml) return null;
    const groups = JSON.parse(run("plutil", ["-extract", "keychain-access-groups", "json", "-o", "-", "-"], {
      encoding: "utf8", input: xml, stdio: ["pipe", "pipe", "ignore"],
    }));
    if (!Array.isArray(groups)) return null;
    return groups.find((group) => {
      if (typeof group !== "string") return false;
      const teamId = group.split(".")[0];
      return /^[A-Z0-9]{10}$/.test(teamId) && group === `${teamId}.${appId}.webauthn`;
    }) ?? null;
  } catch {
    return null;
  }
}

/** The site supplies display names; keep them readable and out of dialog chrome. */
function accountLabel(account, index) {
  const name = account.displayName || account.name || `Passkey ${index + 1}`;
  return String(name).replace(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 70) || `Passkey ${index + 1}`;
}

export async function chooseWebAuthnAccount({ details, window, showMessageBox }) {
  if (!window || window.isDestroyed() || !Array.isArray(details.accounts) || details.accounts.length === 0) return null;
  const accounts = details.accounts;
  let page = 0;
  const perPage = 3;
  while (true) {
    if (window.isDestroyed()) return null;
    const start = page * perPage;
    const slice = accounts.slice(start, start + perPage);
    const hasPrevious = page > 0;
    const hasNext = start + perPage < accounts.length;
    const buttons = ["Cancel", ...slice.map((account, index) => accountLabel(account, start + index))];
    if (hasPrevious) buttons.push("Previous");
    if (hasNext) buttons.push("More passkeys");
    const { response } = await showMessageBox(window, {
      type: "question",
      title: "Choose a passkey",
      message: `Choose a passkey for ${details.relyingPartyId}`,
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (window.isDestroyed() || response === 0) return null;
    if (response <= slice.length) return slice[response - 1]?.credentialId ?? null;
    if (hasPrevious && response === slice.length + 1) { page -= 1; continue; }
    if (hasNext && response === slice.length + (hasPrevious ? 2 : 1)) { page += 1; continue; }
    return null;
  }
}

/** @param {{ app: { isPackaged: boolean, getPath: (name: string) => string, configureWebAuthn?: (options: { touchID: { keychainAccessGroup: string, promptReason: string } }) => void }, appId: string, platform?: string, run?: CommandRunner }} options */
export function configureBrowserWebAuthn({ app, appId, platform = process.platform, run = runStringCommand }) {
  if (platform !== "darwin" || !app.isPackaged || typeof app.configureWebAuthn !== "function") return false;
  const group = signedWebAuthnGroup({ executable: app.getPath("exe"), appId, run });
  if (!group) return false;
  app.configureWebAuthn({ touchID: { keychainAccessGroup: group, promptReason: "sign in to $1" } });
  return true;
}
