import React, { type CSSProperties } from "react"
import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from "@react-email/components"

const LOGO_URL = "https://openworklabs.com/email/openwork-mark.png"

export type ClaimReminderEmailProps = {
  organizationName: string
  claimLink: string
  /** Human-readable expiry, e.g. "Monday, October 6 at 3:00 PM UTC". */
  expiresAtLabel: string
}

export type TeamNudgeEmailProps = {
  organizationName: string
  membersLink: string
  mcpUrl: string
  mcpDocsLink: string
  unsubscribeLink: string
}

export function ClaimReminderEmail({ organizationName, claimLink, expiresAtLabel }: ClaimReminderEmailProps) {
  return (
    <ReminderLayout
      preview={`${organizationName} is waiting for you on OpenWork`}
      footer={
        <>
          You received this because this address was given when {organizationName} was set up. If you don&apos;t claim it, the workspace expires and you won&apos;t hear from us about it again.
        </>
      }
    >
      <Heading style={styles.heading}>Claim {organizationName} before it expires</Heading>
      <Text style={styles.text}>
        Your agent set up <span style={styles.strong}>{organizationName}</span> with a first skill. Claim it by {expiresAtLabel} to keep it, invite your team, and sign in from the app.
      </Text>
      <Button href={claimLink} style={styles.button}>Claim {organizationName}</Button>
      <Fallback link={claimLink} />
    </ReminderLayout>
  )
}

export function TeamNudgeEmail({ organizationName, membersLink, mcpUrl, mcpDocsLink, unsubscribeLink }: TeamNudgeEmailProps) {
  return (
    <ReminderLayout
      preview={`Share ${organizationName} with your team`}
      footer={
        <>
          You received this because you created {organizationName} on OpenWork. <Link href={unsubscribeLink} style={styles.footerLink}>Unsubscribe from these reminders</Link>
        </>
      }
    >
      <Heading style={styles.heading}>Bring your team into {organizationName}</Heading>
      <Text style={styles.text}>
        You&apos;re the only member so far. Invite teammates and everyone gets the same skills, in the OpenWork app and in the AI tools they already use.
      </Text>
      <Button href={membersLink} style={styles.button}>Invite teammates</Button>
      <Hr style={styles.hr} />
      <Text style={styles.fallback}>
        Using Claude, ChatGPT or Cursor as a team? Add <span style={styles.code}>{mcpUrl}</span> once as an organization connector and each person signs in with their OpenWork account. <Link href={mcpDocsLink} style={styles.inlineLink}>How to add it</Link>
      </Text>
    </ReminderLayout>
  )
}

function ReminderLayout({ preview, footer, children }: {
  preview: string
  footer: Parameters<typeof Text>[0]["children"]
  children: Parameters<typeof Section>[0]["children"]
}) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.frame}>
          <Section style={styles.brand}>
            <Img src={LOGO_URL} width="31" height="24" alt="OpenWork" style={styles.brandLogo} />
            <span style={styles.brandName}>OpenWork</span>
          </Section>
          <Section style={styles.card}>{children}</Section>
          <Text style={styles.footer}>
            {footer}
            <br />
            OpenWork · openworklabs.com
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

function Fallback({ link }: { link: string }) {
  return (
    <>
      <Hr style={styles.hr} />
      <Text style={styles.fallback}>If the button doesn&apos;t work, paste this link into your browser:</Text>
      <Text style={styles.link}>{link}</Text>
    </>
  )
}

// Same visual system as the organization invite email.
const styles = {
  body: {
    backgroundColor: "#F0F1F3",
    color: "#1C2024",
    fontFamily: "'IBM Plex Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
    margin: 0,
  },
  frame: { margin: "0 auto", maxWidth: "560px", padding: "56px 0" },
  brand: { marginBottom: "20px", paddingLeft: "4px" },
  brandLogo: { display: "inline-block", verticalAlign: "middle" },
  brandName: { color: "#1C2024", fontSize: "15px", fontWeight: 600, marginLeft: "8px", verticalAlign: "middle" },
  card: { backgroundColor: "#FFFFFF", border: "1px solid #E1E4E8", borderRadius: "16px", padding: "40px" },
  heading: { color: "#1C2024", fontSize: "24px", fontWeight: 600, letterSpacing: "-0.01em", lineHeight: "32px", margin: "0 0 12px" },
  text: { color: "#60646C", fontSize: "15px", lineHeight: "24px", margin: "0 0 28px" },
  strong: { color: "#1C2024", fontWeight: 500 },
  button: {
    backgroundColor: "#1C2024",
    borderRadius: "10px",
    color: "#FFFFFF",
    display: "inline-block",
    fontSize: "15px",
    fontWeight: 500,
    padding: "12px 24px",
    textDecoration: "none",
  },
  hr: { borderColor: "#E1E4E8", margin: "32px 0 20px" },
  fallback: { color: "#60646C", fontSize: "13px", lineHeight: "20px", margin: "0 0 4px" },
  link: { color: "#3E63DD", fontSize: "13px", lineHeight: "20px", margin: 0, wordBreak: "break-all" },
  inlineLink: { color: "#3E63DD" },
  code: { color: "#1C2024", fontFamily: "'IBM Plex Mono', Menlo, monospace", fontSize: "12px", wordBreak: "break-all" },
  footer: { color: "#8B8D98", fontSize: "12px", lineHeight: "18px", margin: "24px 0 0", paddingLeft: "4px" },
  footerLink: { color: "#8B8D98", textDecoration: "underline" },
} satisfies Record<string, CSSProperties>
