import { render } from "@react-email/render"
import nodemailer from "nodemailer"
import { Resend } from "resend"
import { env } from "../../env.js"
import { emailSubjects, type EmailTemplate, type EmailTemplateProps, renderEmailTemplate } from "./templates/index.js"

type EmailProvider = "dev" | "resend" | "nodemailer"

export class DenEmailSendError extends Error {
  readonly reason: "email_not_configured" | "resend_rejected" | "resend_network" | "nodemailer_rejected"
  readonly template: EmailTemplate
  readonly recipient: string
  readonly detail?: string

  constructor(input: {
    template: EmailTemplate
    reason: DenEmailSendError["reason"]
    recipient: string
    detail?: string
  }) {
    super(`[${input.template}] email for ${input.recipient} failed: ${input.reason}${input.detail ? ` (${input.detail})` : ""}`)
    this.name = "DenEmailSendError"
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
  subject?: string
}

export async function sendEmail<Template extends EmailTemplate>(input: SendEmailInput<Template>) {
  const to = input.to.trim()
  if (!to) {
    return
  }

  const subject = input.subject ?? emailSubjects[input.template](input.props)
  const provider = getEmailProvider()

  if (provider === "dev") {
    console.info(`[email] dev email payload for ${to}: ${JSON.stringify({ template: input.template, subject, props: input.props })}`)
    return
  }

  const component = renderEmailTemplate(input.template, input.props)
  const [html, text] = await Promise.all([
    render(component),
    render(component, { plainText: true }),
  ])

  if (provider === "resend") {
    await sendViaResend({ to, subject, html, text, template: input.template })
    return
  }

  await sendViaNodemailer({ to, subject, html, text, template: input.template })
}

function getEmailProvider(): EmailProvider {
  if (env.resend.apiKey) {
    return "resend"
  }
  if (env.smtp.host) {
    return "nodemailer"
  }
  if (env.devMode) {
    return "dev"
  }
  return "nodemailer"
}

async function sendViaResend(input: {
  to: string
  subject: string
  html: string
  text: string
  template: EmailTemplate
}) {
  const from = env.email.from
  if (!env.resend.apiKey || !from) {
    throw new DenEmailSendError({ template: input.template, reason: "email_not_configured", recipient: input.to })
  }

  try {
    const resend = new Resend(env.resend.apiKey)
    const result = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    })

    if (result.error) {
      throw new DenEmailSendError({
        template: input.template,
        reason: "resend_rejected",
        recipient: input.to,
        detail: result.error.message,
      })
    }
  } catch (error) {
    if (error instanceof DenEmailSendError) {
      throw error
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    throw new DenEmailSendError({ template: input.template, reason: "resend_network", recipient: input.to, detail: message })
  }
}

async function sendViaNodemailer(input: {
  to: string
  subject: string
  html: string
  text: string
  template: EmailTemplate
}) {
  const from = env.email.from
  const smtp = env.smtp
  if (!from || !smtp.host) {
    throw new DenEmailSendError({ template: input.template, reason: "email_not_configured", recipient: input.to })
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
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
      html: input.html,
      text: input.text,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    throw new DenEmailSendError({ template: input.template, reason: "nodemailer_rejected", recipient: input.to, detail: message })
  }
}
