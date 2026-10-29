export {
  EmailSendError,
  sendEmail,
  type EmailProvider,
  type EmailSendConfig,
  type SendEmailInput,
  type SmtpEmailConfig,
} from "./send-email.js"
export { renderEmailHtml } from "./render-email.js"
export {
  emailSenderDomain,
  RESEND_DOMAINS_URL,
  verifyEmailTransport,
  type EmailTransportCheck,
  type EmailTransportOutcome,
  type SmtpVerifyOptions,
  type SmtpVerifyTransport,
  type VerifyEmailTransportOptions,
} from "./verify-email.js"
export {
  emailSubjects,
  emailReplyTo,
  renderEmailTemplate,
  type EmailTemplate,
  type EmailTemplateProps,
  type ClaimReminderEmailProps,
  type DownloadLinkEmailProps,
  type FeedbackEmailProps,
  type OrganizationInviteEmailProps,
  type PasswordResetEmailProps,
  type TeamNudgeEmailProps,
  type VerificationEmailProps,
} from "./templates/index.js"
