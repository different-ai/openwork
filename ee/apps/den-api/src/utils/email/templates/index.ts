import { createElement, type ReactElement } from "react"
import { OrganizationInviteEmail, type OrganizationInviteEmailProps } from "./organization-invite.js"
import { VerificationEmail, type VerificationEmailProps } from "./verification.js"

export type EmailTemplateProps = {
  verification: VerificationEmailProps
  organizationInvite: OrganizationInviteEmailProps
}

export type EmailTemplate = keyof EmailTemplateProps

export const emailSubjects: { [Template in EmailTemplate]: (props: EmailTemplateProps[Template]) => string } = {
  verification: ({ verificationCode }) => `Your OpenWork verification code is ${verificationCode}`,
  organizationInvite: ({ organizationName }) => `You're invited to join ${organizationName} on OpenWork`,
}

export function renderEmailTemplate<Template extends EmailTemplate>(
  template: Template,
  props: EmailTemplateProps[Template],
): ReactElement {
  switch (template) {
    case "verification":
      return createElement(VerificationEmail, props as EmailTemplateProps["verification"])
    case "organizationInvite":
      return createElement(OrganizationInviteEmail, props as EmailTemplateProps["organizationInvite"])
  }
}
