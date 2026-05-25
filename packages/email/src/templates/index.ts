import { createElement, type ReactElement } from "react"
import { FeedbackEmail, type FeedbackEmailProps } from "./feedback.js"
import { OrganizationInviteEmail, type OrganizationInviteEmailProps } from "./organization-invite.js"
import { PasswordResetEmail, type PasswordResetEmailProps } from "./password-reset.js"
import { VerificationEmail, type VerificationEmailProps } from "./verification.js"

export type { FeedbackEmailProps } from "./feedback.js"
export type { OrganizationInviteEmailProps } from "./organization-invite.js"
export type { PasswordResetEmailProps } from "./password-reset.js"
export type { VerificationEmailProps } from "./verification.js"

export type EmailTemplateProps = {
  verification: VerificationEmailProps
  passwordReset: PasswordResetEmailProps
  organizationInvite: OrganizationInviteEmailProps
  feedback: FeedbackEmailProps
}

export type EmailTemplate = keyof EmailTemplateProps

export const emailSubjects: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => string } = {
  verification: ({ verificationCode }) => `Your OpenWork verification code is ${verificationCode}`,
  passwordReset: () => "Reset your OpenWork password",
  organizationInvite: ({ organizationName }) => `You're invited to join ${organizationName} on OpenWork`,
  feedback: ({ name, source }) => `OpenWork feedback from ${name}${source ? ` (${source})` : ""}`,
}

export const emailReplyTo: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => string | undefined } = {
  verification: () => undefined,
  passwordReset: () => undefined,
  organizationInvite: () => undefined,
  feedback: ({ email }) => email,
}

export function renderEmailTemplate<Template extends EmailTemplate>(
  template: Template,
  props: EmailTemplateProps[Template],
): ReactElement {
  switch (template) {
    case "verification":
      return createElement(VerificationEmail, props as EmailTemplateProps["verification"])
    case "passwordReset":
      return createElement(PasswordResetEmail, props as EmailTemplateProps["passwordReset"])
    case "organizationInvite":
      return createElement(OrganizationInviteEmail, props as EmailTemplateProps["organizationInvite"])
    case "feedback":
      return createElement(FeedbackEmail, props as EmailTemplateProps["feedback"])
    default:
      throw new Error(`Unknown email template: ${String(template)}`)
  }
}
