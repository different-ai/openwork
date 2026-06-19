import { render } from "@react-email/render"
import nodemailer from "nodemailer"
import { Resend } from "resend"
import { emailReplyTo, emailSubjects, type EmailTemplate, type EmailTemplateProps, renderEmailTemplate } from "./templates/index.js"

export type EmailProvider = "dev" | "resend" | "nodemailer"

export type SmtpEmailConfig = {
  host?: string
  port?: number
  user?: string
  pass?: string
  secure?: boolean
}

export type EmailSendConfig = {
  from?: string
  resendApiKey?: string
  smtp?: SmtpEmailConfig
  devMode?: boolean
}

export class EmailSendError extends Error {
  readonly reason: "email_not_configured" | "resend_rejected" | "resend_network" | "nodemailer_rejected"
  readonly template: EmailTemplate
  readonly recipient: string
  readonly detail?: string

  constructor(input: {
    template: EmailTemplate
    reason: EmailSendError["reason"]
    recipient: string
    detail?: string
  }) {
    super(`[${input.template}] email for ${input.recipient} failed: ${input.reason}${input.detail ? ` (${input.detail})` : ""}`)
    this.name = "EmailSendError"
    this.reason = input.reason
    this.template = input.template
    this.recipient = input.recipient
    this.detail = input.detail
  }
}

export type SendEmailInput<Template extends EmailTemplate = EmailTemplate> = {
  to: string
  template: Template
  props: EmailTemplateProps[Template]
  config: EmailSendConfig
  subject?: string
}

export async function sendEmail<Template extends EmailTemplate>(input: SendEmailInput<Template>) {
  const to = input.to.trim()
  if (!to) {
    return
  }

  const subject = input.subject ?? emailSubjects[input.template](input.props)
  const replyTo = emailReplyTo[input.template](input.props)?.trim() || undefined
  const provider = getEmailProvider(input.config)

  if (provider === "dev") {
    console.info(`[email] dev email payload for ${to}: ${JSON.stringify({ template: input.template, subject, replyTo, props: input.props })}`)
    return
  }

  const component = renderEmailTemplate(input.template, input.props)
  const [html, text] = await Promise.all([
    render(component),
    render(component, { plainText: true }),
  ])

  if (provider === "resend") {
    await sendViaResend({ to, subject, replyTo, html, text, template: input.template, config: input.config })
    return
  }

  await sendViaNodemailer({ to, subject, replyTo, html, text, template: input.template, config: input.config })
}

function getEmailProvider(config: EmailSendConfig): EmailProvider {
  if (config.resendApiKey) {
    return "resend"
  }
  if (config.smtp?.host) {
    return "nodemailer"
  }
  if (config.devMode) {
    return "dev"
  }
  return "nodemailer"
}

async function sendViaResend(input: {
  to: string
  subject: string
  replyTo?: string
  html: string
  text: string
  template: EmailTemplate
  config: EmailSendConfig
}) {
  const from = input.config.from
  const apiKey = input.config.resendApiKey
  if (!apiKey || !from) {
    throw new EmailSendError({ template: input.template, reason: "email_not_configured", recipient: input.to })
  }

  try {
    const resend = new Resend(apiKey)
    const result = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      replyTo: input.replyTo,
      html: input.html,
      text: input.text,
    })

    if (result.error) {
      throw new EmailSendError({
        template: input.template,
        reason: "resend_rejected",
        recipient: input.to,
        detail: result.error.message,
      })
    }
  } catch (error) {
    if (error instanceof EmailSendError) {
      throw error
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    throw new EmailSendError({ template: input.template, reason: "resend_network", recipient: input.to, detail: message })
  }
}

async function sendViaNodemailer(input: {
  to: string
  subject: string
  replyTo?: string
  html: string
  text: string
  template: EmailTemplate
  config: EmailSendConfig
}) {
  const from = input.config.from
  const smtp = input.config.smtp
  if (!from || !smtp?.host) {
    throw new EmailSendError({ template: input.template, reason: "email_not_configured", recipient: input.to })
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port ?? 587,
      secure: smtp.secure ?? false,
      auth: smtp.user
        ? {
            user: smtp.user,
            pass: smtp.pass,
          }
        : undefined,
    })

    await transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      replyTo: input.replyTo,
      html: input.html,
      text: input.text,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    throw new EmailSendError({ template: input.template, reason: "nodemailer_rejected", recipient: input.to, detail: message })
  }
}
