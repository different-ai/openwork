import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudCodingOverview, CloudCodingPushApproval } from "@openwork/types/den/cloud-coding";
import { renderToStaticMarkup } from "react-dom/server";
import { CloudCodingApprovalView, type CloudCodingApprovalViewProps } from "./cloud-coding-approval-view";
import { CloudCodingLinkView, type CloudCodingLinkViewProps } from "./cloud-coding-link-view";
import { githubCallbackError } from "./cloud-coding-ui";
import { CloudCodingView, pullCount, type CloudCodingViewProps } from "./cloud-coding-view";

const date = "2026-11-26T12:30:00Z";
const maya = { login: "maya-chen", linkedAt: date };
const sam = { login: "sam-rivera", linkedAt: date };
const pullUrl = "https://github.com/acme/storefront/pull/482";
const overview: CloudCodingOverview = {
  configured: true, canManage: true, enabled: true,
  connection: { accountLogin: "acme", accountType: "Organization", settingsUrl: "https://github.com/organizations/acme/settings/installations/1", repositorySelection: "selected", connectedAt: date, suspended: false },
  access: { orgWide: true, memberIds: [], teamIds: [] },
  repositories: ["storefront", "billing-api", "docs"].map((name, index) => ({ id: name, fullName: `acme/${name}`, private: true, defaultBranch: "main", pullRequestCount: 2 - index })),
  people: [
    { memberId: "maya", name: "Maya Chen", email: "maya@acme.dev", isYou: true, canUse: true, github: maya },
    { memberId: "sam", name: "Sam Rivera", email: "sam@acme.dev", isYou: false, canUse: true, github: sam },
    { memberId: "leo", name: "Leo Martin", email: "leo@acme.dev", isYou: false, canUse: true, github: null },
    { memberId: "arjun", name: "Arjun Patel", email: "arjun@acme.dev", isYou: false, canUse: true, github: null },
  ],
  me: { memberId: "maya", canUse: true, github: maya },
  pullRequests: [
    { id: "482", title: "Fix one-cent rounding in checkout total", repositoryFullName: "acme/storefront", number: 482, url: pullUrl, state: "open", openedBy: { memberId: "sam", name: "Sam Rivera" }, openedAt: date },
    { id: "1290", title: "Retry the payment webhook after a timeout", repositoryFullName: "acme/billing-api", number: 1290, url: "https://github.com/acme/billing-api/pull/1290", state: "merged", openedBy: { memberId: "maya", name: "Maya Chen" }, openedAt: date },
    { id: "479", title: "Update the returns policy page", repositoryFullName: "acme/storefront", number: 479, url: "https://github.com/acme/storefront/pull/479", state: "closed", openedBy: { memberId: "sam", name: "Sam Rivera" }, openedAt: date },
  ],
};
const disconnected = { ...overview, connection: null };
const unlinked = { ...overview, me: { ...overview.me, github: null } };
const approval: CloudCodingPushApproval = {
  id: "approval", taskId: "task", status: "pending", repositoryFullName: "acme/storefront", branch: "fix-checkout-rounding", baseBranch: "main",
  headSha: "abcdef0123456789abcdef0123456789abcdef01", title: "Fix one-cent rounding in checkout total", requestedAt: date, expiresAt: date, decidedAt: null,
  files: [{ path: "src/total.ts", change: "modified" }, { path: "test/total.test.ts", change: "added" }, { path: "src/old-total.ts", change: "deleted" }],
  fileCount: 5, tests: { status: "passed", command: "pnpm test", summary: "12 tests passed" }, pullRequest: null,
};

function noAction(): never { throw new Error("Rendering must not perform an action"); }
function main(props: Partial<CloudCodingViewProps> = {}) {
  return renderToStaticMarkup(<CloudCodingView onRetry={noAction} onInstall={noAction} onAsk={noAction} onOpenGithub={noAction} onToggle={noAction} onChangeAudience={noAction} onLink={noAction} onSendLink={noAction} {...props} />);
}
function link(props: Partial<CloudCodingLinkViewProps> = {}) {
  return renderToStaticMarkup(<CloudCodingLinkView onRetry={noAction} onLink={noAction} onUnlink={noAction} {...props} />);
}
function push(props: Partial<CloudCodingApprovalViewProps> = {}) {
  return renderToStaticMarkup(<CloudCodingApprovalView onRetry={noAction} onDecision={noAction} {...props} />);
}
function buttonMarkup(html: string) {
  return [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].map(([, attributes, content]) => ({ attributes, label: content.replace(/<[^>]*>/g, "") }));
}
function buttons(html: string) { return buttonMarkup(html).map(({ label }) => label).filter(Boolean); }
function disabled(html: string, label: string) {
  assert.ok(buttonMarkup(html).some((button) => button.label === label && button.attributes.includes('disabled=""')), `${label} is disabled`);
}

for (const [name, render] of [["overview", main], ["link", link], ["approval", push]] as const) {
  test(`${name} preserves row space while loading and offers a retry on error`, () => {
    assert.match(render(), /item-rows-skeleton/);
    assert.doesNotMatch(render(), />Loading/);
    const html = render({ loadError: "Couldn't load this page. Try again." });
    assert.match(html, /role="alert"/);
    assert.deepEqual(buttons(html), ["Try again"]);
  });
}

test("unconfigured and disconnected manager states show the approved setup flow", () => {
  const unavailable = main({ overview: { ...disconnected, configured: false } });
  assert.match(unavailable, /Not set up on this deployment/);
  disabled(unavailable, "Connect GitHub");
  const html = main({ overview: disconnected });
  assert.deepEqual(buttons(html), ["Connect GitHub"]);
  for (const text of ["Let people fix code and open pull requests from any chat, as themselves.", "Not connected", "How it works", "You connect GitHub and choose which repositories OpenWork can use.", "The first time someone asks for a code change, they link their own GitHub account from the chat.", "OpenWork does the work on a cloud computer, then waits for that person to approve the push.", "The pull request opens in their name."]) assert.ok(html.includes(text), text);
  assert.match(main({ overview: disconnected, finishConnecting: true }), /Already installed on GitHub\? Finish connecting/);
});

test("a disconnected member can ask an admin once per session", () => {
  const overview = { ...disconnected, canManage: false };
  const html = main({ overview, finishConnecting: true });
  assert.match(html, /Not connected\. An admin needs to connect GitHub\./);
  assert.deepEqual(buttons(html), ["Ask an admin"]);
  disabled(main({ overview, asked: true }), "Asked");
});

test("the GitHub account chooser renders its loading, empty, error, and account rows", () => {
  const choice = { onRetry: noAction, onConnect: noAction };
  assert.match(main({ overview: disconnected, installations: choice }), /Loading GitHub accounts/);
  assert.match(main({ overview: disconnected, installations: { ...choice, accounts: [] } }), /No GitHub accounts found/);
  assert.match(main({ overview: disconnected, installations: { ...choice, error: "Couldn't load GitHub accounts." } }), /role="alert"/);
  const html = main({ overview: disconnected, installations: { ...choice, pending: true, accounts: [{ installationId: 1, accountLogin: "acme" }, { installationId: 2, accountLogin: "maya-chen" }] } });
  assert.match(html, /Choose a GitHub account/);
  assert.match(html, />acme</);
  assert.match(html, />maya-chen</);
  assert.equal(buttons(html).filter((label) => label === "Connect").length, 2);
  disabled(html, "Connect");
});

for (const [reason, copy] of Object.entries({
  state_invalid: "That GitHub link expired. Try connecting again.",
  not_your_installation: "Your GitHub account can&#x27;t manage that installation. Ask a GitHub owner to connect it.",
  installation_in_use: "That GitHub account is already connected to another OpenWork organization.",
  account_in_use: "That GitHub account is already linked to someone else in this organization.",
  not_allowed: "Only admins can connect GitHub.",
  not_installed: "OpenWork isn&#x27;t installed on a GitHub account you can reach yet. Choose Connect GitHub to install it.",
  not_configured: "GitHub couldn&#x27;t be reached. Try again in a minute.",
  github_error: "GitHub couldn&#x27;t be reached. Try again in a minute.",
})) {
  test(`GitHub callback ${reason} shows plain error copy on both pages`, () => {
    const callbackError = githubCallbackError(reason);
    for (const html of [main({ overview: disconnected, callbackError }), link({ overview: unlinked, callbackError })]) {
      assert.match(html, /role="alert"/);
      assert.ok(html.includes(copy));
    }
  });
}

test("connected manager sees the sections in approved order, people and linked pull requests", () => {
  const html = main({ overview, sentMemberIds: ["leo"] });
  assert.match(html, /On for everyone, 3 repositories/);
  let previous = 0;
  for (const title of ["General", "Repositories", "Rules", "People", "Recent pull requests"]) {
    const index = html.indexOf(`>${title}</h2>`);
    assert.ok(index > previous, title);
    previous = index;
  }
  for (const text of ["Cloud coding", "Who can use it", "Chosen on GitHub", "Ask before every push", "Push to new branches only", "Pull requests open as", "The person who asked", "Maya Chen (you)", "maya-chen", "Not linked yet", "acme/storefront #482 · Open", "acme/billing-api #1290 · Merged", "acme/storefront #479 · Closed", "Opened by"]) assert.ok(html.includes(text), text);
  assert.match(html, /simpleicons[^" ]*github|\/github\.svg|cdn\.jsdelivr\.net[^" ]*github/);
  assert.match(html, /href="https:\/\/github.com\/acme\/storefront\/pull\/482"[^>]*target="_blank"/);
  assert.match(html, /<time/);
  disabled(html, "Sent");
  assert.ok(buttons(html).includes("Send link"));
});

test("audience and repository counts use the correct singular, plural and zero-label forms", () => {
  const single = { ...overview, repositories: overview.repositories.slice(0, 1) };
  assert.match(main({ overview: single }), /On for everyone, 1 repository/);
  assert.match(main({ overview: { ...overview, access: { orgWide: false, memberIds: ["maya", "sam"], teamIds: ["team"] } } }), /On for 2 people and 1 team, 3 repositories/);
  assert.match(main({ overview: { ...single, access: { orgWide: false, memberIds: ["maya"], teamIds: [] } } }), /On for 1 person, 1 repository/);
  assert.match(main({ overview: { ...single, access: { orgWide: false, memberIds: [], teamIds: ["one", "two"] } } }), /On for 2 teams, 1 repository/);
  assert.match(main({ overview: { ...single, access: { orgWide: false, memberIds: [], teamIds: [] } } }), /On for no one, 1 repository/);
  assert.deepEqual([0, 1, 2].map(pullCount), ["No pull requests from OpenWork yet", "1 pull request from OpenWork", "2 pull requests from OpenWork"]);
});

test("read-only members see the lock and can link themselves, but not change settings or send links", () => {
  const html = main({ overview: { ...unlinked, canManage: false, people: overview.people.map((person) => ({ ...person, github: person.isYou ? null : person.github, canUse: person.memberId !== "arjun" })) } });
  assert.match(html, /Only admins can change this/);
  assert.match(html, /role="switch" aria-checked="true"[^>]*disabled=""/);
  assert.match(html, /Not included/);
  assert.deepEqual(buttons(html), ["Link your account"]);
});

test("turned off, suspended, empty and settings-error states retain the relevant sections", () => {
  const html = main({ overview: { ...overview, enabled: false, repositories: [], pullRequests: [], connection: { ...overview.connection, accountLogin: "acme", accountType: "Organization", settingsUrl: "https://github.com/organizations/acme/settings/installations/1", repositorySelection: "selected", connectedAt: date, suspended: true } }, settingsError: "Couldn't save Cloud coding settings. Try again." });
  for (const text of ["Off for everyone", "GitHub paused OpenWork&#x27;s access. Resume it on GitHub.", "No repositories chosen yet", "No pull requests yet. They&#x27;ll show up here after someone&#x27;s first push.", "Couldn&#x27;t save Cloud coding settings.", "Recent pull requests"]) assert.ok(html.includes(text), text);
  assert.match(html, /role="switch" aria-checked="false"/);
  assert.match(html, /role="alert"/);
  assert.ok(buttons(html).includes("Open GitHub"));
  assert.equal(buttons(html).filter((label) => label === "Add repositories").length, 1);
});

test("the link page reports linked and unlinked states and explains what linking does", () => {
  const linked = link({ overview, linked: true });
  assert.match(linked, /Linked as maya-chen/);
  assert.match(linked, /You can go back to your chat\./);
  assert.match(linked, /data-notice-tone="success"/);
  assert.deepEqual(buttons(linked), ["Unlink"]);
  const html = link({ overview: unlinked });
  assert.match(html, /Not linked/);
  assert.match(html, /Pull requests OpenWork opens for you will be in your name\./);
  assert.deepEqual(buttons(html), ["Link your GitHub account"]);
});

test("the link page shows the reason and no action when blocked", () => {
  for (const [data, copy] of [
    [{ ...unlinked, connection: null }, "An admin needs to connect GitHub first"],
    [{ ...unlinked, enabled: false }, "Cloud coding is turned off for your organization"],
    [{ ...overview, enabled: false }, "Cloud coding is turned off for your organization"],
    [{ ...unlinked, me: { ...unlinked.me, canUse: false } }, "You&#x27;re not included yet. Ask an admin to add you."],
  ] as const) {
    const html = link({ overview: data });
    assert.ok(html.includes(copy), copy);
    assert.deepEqual(buttons(html), []);
    assert.match(html, /lucide-lock/);
  }
});

test("pending approval names the operation and exactly two decision actions", () => {
  const html = push({ approval });
  for (const text of ["Push to acme/storefront?", "OpenWork will push this as a new branch and open a pull request in your name. Nothing has been sent to GitHub yet.", "fix-checkout-rounding", "main", "abcdef0", "Passed", "pnpm test", "12 tests passed", "5 files", "src/total.ts", "Changed", "Added", "Removed", "and 2 more"]) assert.ok(html.includes(text), text);
  assert.ok(!html.includes(approval.headSha));
  assert.deepEqual(buttons(html), ["Deny", "Allow once"]);
  const pending = push({ approval, decisionPending: true });
  disabled(pending, "Deny");
  disabled(pending, "Allow once");
});

test("approval distinguishes test failure from tests not run", () => {
  const failed = push({ approval: { ...approval, tests: { ...approval.tests, status: "failed" } } });
  assert.match(failed, /text-\[var\(--ow-danger\)\]/);
  assert.match(failed, />Failed</);
  const notRun = push({ approval: { ...approval, tests: { status: "not_run", command: null, summary: null } } });
  assert.match(notRun, />Not run</);
  assert.doesNotMatch(notRun, /pnpm test|12 tests passed/);
});

for (const [status, copy] of [
  ["approved", "Allowed. OpenWork is pushing the branch."],
  ["denied", "Denied. Nothing was pushed."],
  ["expired", "This request expired. Ask OpenWork to try again."],
  ["superseded", "OpenWork changed the code after this request. Check your chat for the new one."],
  ["pushed", "Pull request opened"],
] as const) {
  test(`${status} approval shows its outcome in place and no decision actions`, () => {
    const html = push({ approval: { ...approval, status } });
    assert.ok(html.includes(copy));
    assert.match(html, /fix-checkout-rounding/);
    assert.deepEqual(buttons(html), []);
  });
}

test("approval with a pull request shows a link; unavailable approval hides details and actions", () => {
  const html = push({ approval: { ...approval, status: "approved", pullRequest: { number: 482, url: pullUrl, state: "open" } } });
  assert.match(html, /Pull request opened/);
  assert.match(html, /href="https:\/\/github.com\/acme\/storefront\/pull\/482"[^>]*target="_blank"[^>]*>acme\/storefront #482/);
  const unavailable = push({ approval, unavailable: true });
  assert.match(unavailable, /This request isn&#x27;t available\. It may belong to another account\./);
  assert.doesNotMatch(unavailable, /fix-checkout-rounding/);
  assert.deepEqual(buttons(unavailable), []);
});
