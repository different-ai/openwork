import { EmailSendError, emailSubjects, renderEmailHtml, sendEmail as sendSharedEmail, type EmailTemplate, type SendEmailInput } from "@openwork/email"
import { env } from "../../env.js"
import { appLogger } from "../../observability/logger.js"

export { EmailSendError as DenEmailSendError }

export type DevEmailOutboxEntry = {
  template: EmailTemplate
  to: string
  subject: string
  html: string
  at: string
}

export type DevEmailOutboxMetadata = Omit<DevEmailOutboxEntry, "html">

const DEV_EMAIL_OUTBOX_MAX = 20
const devEmailOutbox: DevEmailOutboxEntry[] = []
const logger = appLogger.child({ component: "email" })

// Dev/eval-only affordance: when OPENWORK_DEV_MODE=1, keep the last few
// rendered emails in memory so UI evals can inspect real HTML without a mail
// provider. Never expose or populate this buffer outside dev mode.
function recordDevEmail(input: DevEmailOutboxEntry) {
  if (!env.devMode) {
    return
  }

  devEmailOutbox.push(input)
  if (devEmailOutbox.length > DEV_EMAIL_OUTBOX_MAX) {
    devEmailOutbox.splice(0, devEmailOutbox.length - DEV_EMAIL_OUTBOX_MAX)
  }
}

export function listDevEmails(template?: EmailTemplate): DevEmailOutboxMetadata[] {
  const entries = template
    ? devEmailOutbox.filter((entry) => entry.template === template)
    : devEmailOutbox

  return entries
    .slice()
    .reverse()
    .map((entry) => ({
      template: entry.template,
      to: entry.to,
      subject: entry.subject,
      at: entry.at,
    }))
}

export function getLastDevEmail(template?: EmailTemplate): DevEmailOutboxEntry | null {
  for (let index = devEmailOutbox.length - 1; index >= 0; index -= 1) {
    const entry = devEmailOutbox[index]
    if (!template || entry.template === template) {
      return entry
    }
  }

  return null
}

export async function sendEmail<Template extends EmailTemplate>(
  input: Omit<SendEmailInput<Template>, "config">,
) {
  const to = input.to.trim()
  const subject = input.subject ?? emailSubjects[input.template](input.props)

  logger.info("sending email", {
    template: input.template,
    has_from: Boolean(env.email.from),
    has_resend: Boolean(env.resend.apiKey),
    has_smtp: Boolean(env.smtp.host),
  })

  if (env.devMode && to) {
    recordDevEmail({
      template: input.template,
      to,
      subject,
      html: await renderEmailHtml(input.template, input.props),
      at: new Date().toISOString(),
    })
  }

  try {
    await sendSharedEmail({
      ...input,
      subject,
      config: {
        devMode: env.devMode,
        from: env.email.from,
        resendApiKey: env.resend.apiKey,
        smtp: env.smtp,
      },
    })
    logger.info("email sent", { template: input.template })
  } catch (error) {
    logger.error("email failed", { template: input.template, error })
    throw error
  }
}
