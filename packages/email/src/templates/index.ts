import { createElement, type ReactElement } from "react"
import { CloudCodingLinkGithub, type CloudCodingLinkGithubProps } from "./cloud-coding-link-github.js"
import { CloudCodingAdminRequest, type CloudCodingAdminRequestProps } from "./cloud-coding-admin-request.js"
import { DownloadLinkEmail, type DownloadLinkEmailProps } from "./download-link.js"
import { FeedbackEmail, type FeedbackEmailProps } from "./feedback.js"
import { ClaimReminderEmail, TeamNudgeEmail, type ClaimReminderEmailProps, type TeamNudgeEmailProps } from "./lifecycle-reminders.js"
import { OrganizationInviteEmail, type OrganizationInviteEmailProps } from "./organization-invite.js"
import { PasswordResetEmail, type PasswordResetEmailProps } from "./password-reset.js"
import { VerificationEmail, type VerificationEmailProps } from "./verification.js"

export type { DownloadLinkEmailProps } from "./download-link.js"
export type { FeedbackEmailProps } from "./feedback.js"
export type { ClaimReminderEmailProps, TeamNudgeEmailProps } from "./lifecycle-reminders.js"
export type { OrganizationInviteEmailProps } from "./organization-invite.js"
export type { PasswordResetEmailProps } from "./password-reset.js"
export type { VerificationEmailProps } from "./verification.js"

export type EmailTemplateProps = {
  verification: VerificationEmailProps
  passwordReset: PasswordResetEmailProps
  organizationInvite: OrganizationInviteEmailProps
  downloadLink: DownloadLinkEmailProps
  feedback: FeedbackEmailProps
  claimReminder: ClaimReminderEmailProps
  cloudCodingLinkGithub: CloudCodingLinkGithubProps
  cloudCodingAdminRequest: CloudCodingAdminRequestProps
  teamNudge: TeamNudgeEmailProps
}

export type EmailTemplate = keyof EmailTemplateProps

export const emailSubjects: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => string } = {
  verification: ({ verificationCode }) => `Your OpenWork verification code is ${verificationCode}`,
  passwordReset: () => "Reset your OpenWork password",
  organizationInvite: ({ invitedByName, organizationName }) => `${invitedByName} invited you to join ${organizationName} on OpenWork`,
  downloadLink: () => "Your OpenWork download link",
  feedback: ({ name, source }) => `OpenWork feedback from ${name}${source ? ` (${source})` : ""}`,
  claimReminder: ({ organizationName }) => `Claim ${organizationName} before it expires`,
  cloudCodingLinkGithub: () => "Link your GitHub account",
  cloudCodingAdminRequest: ({ requesterName }) => `${requesterName} asked to use Cloud coding`,
  teamNudge: ({ organizationName }) => `Bring your team into ${organizationName}`,
}

export const emailReplyTo: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => string | undefined } = {
  verification: () => undefined,
  passwordReset: () => undefined,
  organizationInvite: ({ supportEmail, invitedByEmail }) => supportEmail || invitedByEmail || undefined,
  downloadLink: () => undefined,
  feedback: ({ email }) => email,
  claimReminder: () => undefined,
  cloudCodingLinkGithub: () => undefined,
  cloudCodingAdminRequest: () => undefined,
  teamNudge: () => undefined,
}

const emailRenderers: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => ReactElement } = {
  verification: (props) => createElement(VerificationEmail, props),
  passwordReset: (props) => createElement(PasswordResetEmail, props),
  organizationInvite: (props) => createElement(OrganizationInviteEmail, props),
  downloadLink: (props) => createElement(DownloadLinkEmail, props),
  feedback: (props) => createElement(FeedbackEmail, props),
  claimReminder: (props) => createElement(ClaimReminderEmail, props),
  cloudCodingLinkGithub: (props) => createElement(CloudCodingLinkGithub, props),
  cloudCodingAdminRequest: (props) => createElement(CloudCodingAdminRequest, props),
  teamNudge: (props) => createElement(TeamNudgeEmail, props),
}

export function renderEmailTemplate<Template extends EmailTemplate>(
  template: Template,
  props: EmailTemplateProps[Template],
): ReactElement {
  return emailRenderers[template](props)
}
