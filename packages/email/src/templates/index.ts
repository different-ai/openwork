import { createElement, type ReactElement } from "react"
import { ConnectDesktopEmail, type ConnectDesktopEmailProps } from "./connect-desktop.js"
import { DownloadLinkEmail, type DownloadLinkEmailProps } from "./download-link.js"
import { FeedbackEmail, type FeedbackEmailProps } from "./feedback.js"
import { OrganizationInviteEmail, type OrganizationInviteEmailProps } from "./organization-invite.js"
import { PasswordResetEmail, type PasswordResetEmailProps } from "./password-reset.js"
import { VerificationEmail, type VerificationEmailProps } from "./verification.js"

export type { ConnectDesktopEmailProps } from "./connect-desktop.js"
export type { DownloadLinkEmailProps } from "./download-link.js"
export type { FeedbackEmailProps } from "./feedback.js"
export type { OrganizationInviteEmailProps } from "./organization-invite.js"
export type { PasswordResetEmailProps } from "./password-reset.js"
export type { VerificationEmailProps } from "./verification.js"

export type EmailTemplateProps = {
  verification: VerificationEmailProps
  passwordReset: PasswordResetEmailProps
  organizationInvite: OrganizationInviteEmailProps
  downloadLink: DownloadLinkEmailProps
  connectDesktop: ConnectDesktopEmailProps
  feedback: FeedbackEmailProps
}

export type EmailTemplate = keyof EmailTemplateProps

export const emailSubjects: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => string } = {
  verification: ({ verificationCode }) => `Your OpenWork verification code is ${verificationCode}`,
  passwordReset: () => "Reset your OpenWork password",
  organizationInvite: ({ organizationName }) => `You're invited to join ${organizationName} on OpenWork`,
  downloadLink: () => "Your OpenWork download link",
  connectDesktop: ({ organizationName }) => `Connect your OpenWork desktop to ${organizationName}`,
  feedback: ({ name, source }) => `OpenWork feedback from ${name}${source ? ` (${source})` : ""}`,
}

export const emailReplyTo: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => string | undefined } = {
  verification: () => undefined,
  passwordReset: () => undefined,
  organizationInvite: () => undefined,
  downloadLink: () => undefined,
  connectDesktop: () => undefined,
  feedback: ({ email }) => email,
}

const emailRenderers: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => ReactElement } = {
  verification: (props) => createElement(VerificationEmail, props),
  passwordReset: (props) => createElement(PasswordResetEmail, props),
  organizationInvite: (props) => createElement(OrganizationInviteEmail, props),
  downloadLink: (props) => createElement(DownloadLinkEmail, props),
  connectDesktop: (props) => createElement(ConnectDesktopEmail, props),
  feedback: (props) => createElement(FeedbackEmail, props),
}

export function renderEmailTemplate<Template extends EmailTemplate>(
  template: Template,
  props: EmailTemplateProps[Template],
): ReactElement {
  return emailRenderers[template](props)
}
