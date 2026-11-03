import React, { type CSSProperties } from "react"
import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from "@react-email/components"

const LOGO_URL = "https://openworklabs.com/email/openwork-mark.png"

export type OrganizationInviteEmailProps = {
  /** Opens the join page for this invitation: it signs the person in (password, Google or SSO) and adds them to the organization. */
  inviteLink: string
  invitedByName: string
  invitedByEmail: string
  organizationName: string
  role: string
  /** The address the invitation was sent to; the person signs in with it. */
  inviteeEmail: string
  gettingStartedUrl: string
  /** Replies go here. Without one, replies reach the person who sent the invitation. */
  supportEmail?: string
  /** Where a recipient reports an invitation they do not trust. Omitted when the deployment has nowhere to send reports. */
  reportAbuseUrl?: string
  /** Company or deployment details shown at the bottom, one line each. */
  footerLines: string[]
}

export function OrganizationInviteEmail({
  inviteLink,
  invitedByName,
  invitedByEmail,
  organizationName,
  role,
  inviteeEmail,
  gettingStartedUrl,
  supportEmail,
  reportAbuseUrl,
  footerLines,
}: OrganizationInviteEmailProps) {
  const showInviterEmail = Boolean(invitedByEmail) && invitedByEmail !== invitedByName

  return (
    <Html>
      <Head />
      <Preview>{invitedByName} invited you to join {organizationName} on OpenWork</Preview>
      <Body style={styles.body}>
        <Container style={styles.frame}>
          <Section style={styles.brand}>
            <Img src={LOGO_URL} width="31" height="24" alt="" style={styles.brandLogo} />
            <span style={styles.brandName}>OpenWork</span>
          </Section>
          <Section style={styles.card}>
            <Heading style={styles.heading}>Welcome to OpenWork</Heading>
            <Text style={styles.text}>
              {invitedByName}
              {showInviterEmail ? <> (<Link href={`mailto:${invitedByEmail}`} style={styles.inlineLink}>{invitedByEmail}</Link>)</> : null}
              {" "}has invited you to join the <span style={styles.strong}>{organizationName}</span> workspace on OpenWork
              {role ? ` as ${articleFor(role)} ${role}` : ""}. Join to work with your team&apos;s shared skills, connected apps and AI models in one place.
            </Text>
            <Text style={styles.text}>
              To join, accept the invite and sign in with <span style={styles.strong}>{inviteeEmail}</span>. You can then download the OpenWork desktop app.
            </Text>
            <Text style={styles.text}>You should only accept invites from people you trust.</Text>
            <Section style={styles.actions}>
              <Button href={inviteLink} style={styles.button}>Accept invite</Button>
            </Section>
            <Text style={styles.text}>
              Need help getting started? See our <Link href={gettingStartedUrl} style={styles.inlineLink}>quickstart</Link>, or reply to this email to {supportEmail ? "talk to our support team" : `reach ${invitedByName}`}.
            </Text>
            <Text style={styles.small}>
              Does this email look suspicious, or you don&apos;t recognize the sender?{" "}
              {reportAbuseUrl
                ? <Link href={reportAbuseUrl} style={styles.inlineLink}>Report abuse</Link>
                : "Ignore it. Nothing happens unless you accept."}
            </Text>
            <Hr style={styles.hr} />
            <Text style={styles.fallback}>If the button doesn&apos;t work, paste this link into your browser:</Text>
            <Text style={styles.link}>{inviteLink}</Text>
          </Section>
          <Section style={styles.footer}>
            {footerLines.map((line) => <Text key={line} style={styles.footerLine}>{line}</Text>)}
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

function articleFor(value: string) {
  return /^[aeiou]/i.test(value.trim()) ? "an" : "a"
}

const styles = {
  body: {
    backgroundColor: "#F0F1F3",
    color: "#1C2024",
    fontFamily: "'IBM Plex Sans', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
    margin: 0,
  },
  frame: {
    margin: "0 auto",
    maxWidth: "560px",
    padding: "48px 0",
  },
  brand: {
    marginBottom: "24px",
    textAlign: "center",
  },
  brandLogo: {
    display: "inline-block",
    verticalAlign: "middle",
  },
  brandName: {
    color: "#1C2024",
    fontSize: "18px",
    fontWeight: 600,
    marginLeft: "8px",
    verticalAlign: "middle",
  },
  card: {
    backgroundColor: "#FFFFFF",
    border: "1px solid #E1E4E8",
    borderRadius: "16px",
    padding: "40px",
  },
  heading: {
    color: "#1C2024",
    fontSize: "24px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    lineHeight: "32px",
    margin: "0 0 20px",
  },
  text: {
    color: "#3A3F47",
    fontSize: "15px",
    lineHeight: "24px",
    margin: "0 0 16px",
  },
  strong: {
    color: "#1C2024",
    fontWeight: 600,
  },
  inlineLink: {
    color: "#3E63DD",
    textDecoration: "underline",
  },
  actions: {
    margin: "12px 0 28px",
    textAlign: "center",
  },
  button: {
    backgroundColor: "#1C2024",
    borderRadius: "10px",
    color: "#FFFFFF",
    display: "inline-block",
    fontSize: "15px",
    fontWeight: 600,
    padding: "12px 28px",
    textDecoration: "none",
  },
  small: {
    color: "#60646C",
    fontSize: "13px",
    lineHeight: "20px",
    margin: "0",
  },
  hr: {
    borderColor: "#E1E4E8",
    margin: "28px 0 16px",
  },
  fallback: {
    color: "#60646C",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 4px",
  },
  link: {
    color: "#3E63DD",
    fontSize: "12px",
    lineHeight: "18px",
    margin: 0,
    wordBreak: "break-all",
  },
  footer: {
    margin: "24px 0 0",
    textAlign: "center",
  },
  footerLine: {
    color: "#8B8D98",
    fontSize: "12px",
    lineHeight: "18px",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>
