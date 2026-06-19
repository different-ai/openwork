export {
  EmailSendError,
  sendEmail,
  type EmailProvider,
  type EmailSendConfig,
  type SendEmailInput,
  type SmtpEmailConfig,
} from "./send-email.js"
export {
  emailSubjects,
  emailReplyTo,
  renderEmailTemplate,
  type EmailTemplate,
  type EmailTemplateProps,
  type FeedbackEmailProps,
  type OrganizationInviteEmailProps,
  type PasswordResetEmailProps,
  type VerificationEmailProps,
} from "./templates/index.js"
