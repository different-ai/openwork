import assert from "node:assert/strict"
import { test } from "node:test"
import { emailReplyTo, emailSubjects, renderEmailHtml } from "@openwork/email"

// Importing the builder never touches the database; these only satisfy env validation.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/invitation_email_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-invitation-email-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-invitation-email-unit-test-encryption"
process.env.OPENWORK_DEV_MODE ??= "1"

const { organizationInviteEmailProps } = await import("../src/invitation-email.js")

const invitation = {
  inviteLink: "https://den.example.test/join-org?invite=invite_token_1",
  inviterName: "Ada Lovelace",
  inviterEmail: "ada@example.test",
  inviteeEmail: "grace@example.test",
  organizationName: "Example Labs",
  role: "member",
}

function text(html: string) {
  return html.replace(/<!--.*?-->/gs, "").replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ")
}

function hrefs(html: string) {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replaceAll("&amp;", "&"))
}

test("Cloud invitation: inviter, workspace, accept link, quickstart, support replies and report link", async () => {
  const props = organizationInviteEmailProps(invitation, { deployment: "cloud", webUrl: "https://app.openworklabs.com", now: new Date("2026-10-22T00:00:00Z") })
  assert.equal(emailSubjects.organizationInvite(props), "Ada Lovelace invited you to join Example Labs on OpenWork")
  assert.equal(emailReplyTo.organizationInvite(props), "team@openworklabs.com")

  const html = await renderEmailHtml("organizationInvite", props)
  const body = text(html)
  for (const line of [
    "Welcome to OpenWork",
    "Ada Lovelace ( ada@example.test ) has invited you to join the Example Labs workspace on OpenWork as a member.",
    "sign in with grace@example.test",
    "You should only accept invites from people you trust.",
    "Accept invite",
    "reply to this email to talk to our support team.",
    "Report abuse",
    "© 2026 Different AI. All rights reserved.",
  ]) assert.ok(body.includes(line), `missing: ${line}\n${body}`)

  const links = hrefs(html)
  assert.ok(links.includes(invitation.inviteLink))
  assert.ok(links.includes("https://openworklabs.com/docs/cloud/team-quickstart"))
  const report = links.find((link) => link.startsWith("mailto:team@openworklabs.com?"))
  assert.ok(report, "report abuse goes to OpenWork support")
  assert.ok(decodeURIComponent(report).includes("Workspace: Example Labs"))
})

test("Enterprise invitation with a configured help desk: replies and reports go there, footer names the server", async () => {
  const props = organizationInviteEmailProps(invitation, { deployment: "self_hosted", supportAddress: "it-help@example.test", webUrl: "https://openwork.example.internal" })
  assert.equal(emailReplyTo.organizationInvite(props), "it-help@example.test")

  const html = await renderEmailHtml("organizationInvite", props)
  const body = text(html)
  assert.ok(body.includes("Sent by the OpenWork server at openwork.example.internal for Example Labs."))
  assert.ok(!body.includes("Different AI"))
  assert.ok(hrefs(html).some((link) => link.startsWith("mailto:it-help@example.test?")))
  assert.ok(hrefs(html).includes("https://openworklabs.com/docs/start-here/get-started"))
})

test("Enterprise invitation without a help desk: replies reach the inviter and no report link points at OpenWork", async () => {
  const props = organizationInviteEmailProps(invitation, { deployment: "self_hosted", webUrl: "https://openwork.example.internal" })
  assert.equal(props.supportEmail, undefined)
  assert.equal(props.reportAbuseUrl, undefined)
  assert.equal(emailReplyTo.organizationInvite(props), "ada@example.test")

  const html = await renderEmailHtml("organizationInvite", props)
  const body = text(html)
  assert.ok(body.includes("reply to this email to reach Ada Lovelace."))
  assert.ok(body.includes("Ignore it. Nothing happens unless you accept."))
  assert.ok(!html.includes("openworklabs.com?"))
})

test("An inviter without a name is shown by email once", async () => {
  const props = organizationInviteEmailProps({ ...invitation, inviterName: null }, { deployment: "cloud", webUrl: "https://app.openworklabs.com" })
  assert.equal(props.invitedByName, "ada@example.test")
  const body = text(await renderEmailHtml("organizationInvite", props))
  assert.ok(body.includes("ada@example.test has invited you"))
  assert.ok(!body.includes("( ada@example.test )"))
})
