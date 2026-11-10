import type { OAuthAccount } from "./index.ts";

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeOAuthHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

// Inline vector and system fonts keep browser worlds completely offline.
const googleMark = `<svg class="google-mark" viewBox="0 0 24 24" role="img" aria-label="Google"><path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z"/><path fill="#34a853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.23-2.51c-.9.6-2.04.96-3.39.96-2.61 0-4.82-1.76-5.61-4.12H3.05v2.59A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.39 13.92A6 6 0 0 1 6.08 12c0-.67.11-1.31.31-1.92V7.49H3.05A10 10 0 0 0 2 12c0 1.61.39 3.14 1.05 4.51l3.34-2.59Z"/><path fill="#ea4335" d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.86-2.86A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.49l3.34 2.59C7.18 7.72 9.39 5.96 12 5.96Z"/></svg>`;

const styles = `
:root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; color: #1f1f1f; background: #f0f4f9; font-synthesis: none; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 280px; min-height: 100vh; display: grid; place-items: center; padding: 48px 24px; }
.shell { width: min(1040px, 100%); }
.card { background: #fff; border-radius: 28px; padding: 36px 40px 40px; }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; font-size: 14px; line-height: 20px; }
.google-mark { width: 24px; height: 24px; flex: none; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; min-height: 242px; }
h1 { font-size: 36px; line-height: 1.24; letter-spacing: -.6px; font-weight: 400; margin: 0 0 18px; overflow-wrap: anywhere; }
p { font-size: 14px; line-height: 1.55; margin: 0; }
.subtitle { font-size: 16px; }
.app-name { color: #0b57d0; font-weight: 500; }
.accounts { padding-top: 1px; }
.account { font: inherit; color: inherit; display: flex; align-items: center; gap: 16px; width: 100%; border: 0; border-bottom: 1px solid #dadce0; background: transparent; text-align: left; padding: 16px 12px; cursor: pointer; min-height: 76px; }
.account:hover { background: #f2f6fc; }
.account:focus-visible, .button:focus-visible { outline: 3px solid #1a73e8; outline-offset: 3px; }
.avatar { display: inline-grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 50%; background: #7b1fa2; color: #fff; font-size: 18px; font-weight: 500; }
.account-text { min-width: 0; display: grid; gap: 3px; }
.account-name { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.account-email { font-size: 13px; line-height: 18px; color: #444746; overflow-wrap: anywhere; }
.identity { display: inline-flex; align-items: center; max-width: 100%; gap: 8px; border: 1px solid #747775; border-radius: 20px; padding: 5px 12px 5px 5px; margin-top: 4px; }
.identity .avatar { width: 24px; height: 24px; font-size: 12px; }
.identity .account-email { color: #1f1f1f; }
.permissions { padding-top: 3px; }
.permissions h2 { margin: 0 0 20px; font-weight: 400; font-size: 16px; line-height: 24px; }
.scope-list { list-style: none; margin: 0 0 24px; padding: 0; }
.scope-list li { display: flex; align-items: flex-start; gap: 14px; margin: 0 0 16px; font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
.check { color: #0b57d0; font-size: 18px; width: 20px; flex: none; }
.disclosure { color: #444746; font-size: 13px; }
.actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 32px; }
.button { font: inherit; font-size: 14px; font-weight: 600; min-height: 40px; min-width: 108px; padding: 10px 24px; border-radius: 24px; cursor: pointer; background: #fff; color: #0b57d0; border: 1px solid #747775; }
.button:hover { background: #f2f6fc; }
.button.primary { color: #fff; background: #0b57d0; border-color: #0b57d0; }
.button.primary:hover { background: #0842a0; }
footer { display: flex; justify-content: space-between; gap: 16px; padding: 20px 16px 0; color: #444746; font-size: 12px; line-height: 18px; }
@media (max-width: 760px) {
  body { padding: 24px 16px; }
  .card { padding: 28px 24px 32px; border-radius: 24px; }
  .brand { margin-bottom: 28px; }
  .columns { grid-template-columns: 1fr; gap: 28px; min-height: auto; }
  h1 { font-size: 30px; }
  footer { padding: 16px 8px 0; flex-wrap: wrap; gap: 4px 16px; }
}
`;

function avatar(account: OAuthAccount): string {
  const initial = Array.from(account.name.trim() || account.email)[0]?.toUpperCase() ?? "?";
  return `<span class="avatar" aria-hidden="true">${escapeOAuthHtml(initial)}</span>`;
}

function document(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeOAuthHtml(title)}</title><style>${styles}</style></head><body><div class="shell"><main class="card"><div class="brand">${googleMark}<span>Sign in with Google</span></div>${content}</main><footer><span>Local OAuth test provider</span><span>Fictional accounts · No real credentials</span></footer></div></body></html>`;
}

export function accountChooserPage(input: { accounts: readonly OAuthAccount[]; interaction: string; applicationName: string; action: string }): string {
  const app = escapeOAuthHtml(input.applicationName);
  const accounts = input.accounts.map((account) => `<button class="account" name="account" value="${escapeOAuthHtml(account.sub)}">${avatar(account)}<span class="account-text"><span class="account-name">${escapeOAuthHtml(account.name)}</span><span class="account-email">${escapeOAuthHtml(account.email)}</span></span></button>`).join("");
  return document("Choose an account", `<div class="columns"><section><h1>Choose an account</h1><p class="subtitle">to continue to <span class="app-name">${app}</span></p></section><section aria-label="Accounts"><form class="accounts" method="post" action="${escapeOAuthHtml(input.action)}"><input type="hidden" name="interaction" value="${escapeOAuthHtml(input.interaction)}">${accounts}</form></section></div>`);
}

function describeScope(scope: string): string {
  switch (scope) {
    case "openid": return "Confirm your identity";
    case "email":
    case "https://www.googleapis.com/auth/userinfo.email": return "See your email address";
    case "profile":
    case "https://www.googleapis.com/auth/userinfo.profile": return "See your name and profile picture";
    default: return `Access the requested permission: ${scope}`;
  }
}

export function consentPage(input: { account: OAuthAccount; interaction: string; applicationName: string; scope: string; action: string }): string {
  const app = escapeOAuthHtml(input.applicationName);
  const scopeItems = [...new Set(input.scope.split(/\s+/).filter(Boolean))].map((scope) => `<li><span class="check" aria-hidden="true">✓</span><span>${escapeOAuthHtml(describeScope(scope))}</span></li>`).join("");
  return document(`Sign in to ${input.applicationName}`, `<div class="columns"><section><h1>Sign in to ${app}</h1><div class="identity">${avatar(input.account)}<span class="account-email">${escapeOAuthHtml(input.account.email)}</span></div></section><section class="permissions"><h2>${app} will receive this information about you</h2><ul class="scope-list">${scopeItems}</ul><p class="disclosure">Continue to share the information above with ${app} for this sign-in. Cancel to return without signing in.</p><form method="post" action="${escapeOAuthHtml(input.action)}"><input type="hidden" name="interaction" value="${escapeOAuthHtml(input.interaction)}"><div class="actions"><button class="button" name="decision" value="deny">Cancel</button><button class="button primary" name="decision" value="approve">Continue</button></div></form></section></div>`);
}
