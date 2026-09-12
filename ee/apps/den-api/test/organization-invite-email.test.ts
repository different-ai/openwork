import { renderEmailHtml } from "@openwork/email"
import { expect, test } from "bun:test"
import { DomUtils, parseDocument } from "htmlparser2"

test("organization invitation HTML focuses on joining without desktop download prompt", async () => {
  const inviteLink = "https://on-prem.example.test/join-org?invite=invitation-token"
  const downloadUrl = "https://on-prem.example.test/install?token=org-install-token"
  const html = await renderEmailHtml("organizationInvite", {
    inviteLink,
    invitedByName: "Riley",
    invitedByEmail: "riley@example.test",
    organizationName: "Acme Robotics",
    role: "member",
  })
  const text = htmlText(html)

  expect(text).toContain("Join Acme Robotics")
  expect(text).toContain("Riley (riley@example.test) invited you to join the Acme Robotics workspace as a member.")
  expect(text).toContain("Accept invite")
  expect(html).toContain(inviteLink)
  expect(html).not.toContain("Download the desktop app")
  expect(html).not.toContain("OpenWork desktop app")
  expect(html).not.toContain(downloadUrl)
})

test("verification email includes an absolute code-entry recovery link", async () => {
  const recoveryUrl = "https://app.example.test/verify?email=member%40example.test"
  const html = await renderEmailHtml("verification", { verificationCode: "123456", recoveryUrl })
  expect(htmlText(html)).toContain("123456")
  expect(html).toContain(`href="${recoveryUrl}"`)
  expect(htmlText(html)).toContain("Return to enter your verification code")
  expect(new URL(recoveryUrl).protocol).toBe("https:")
  expect(new URL(recoveryUrl).searchParams.has("token")).toBe(false)
})

function htmlText(value: string) {
  return DomUtils.textContent(parseDocument(value))
    .replace(/\s+/g, " ")
    .trim()
}
