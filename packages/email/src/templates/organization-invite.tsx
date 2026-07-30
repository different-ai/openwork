import React, { type CSSProperties } from "react"
import { Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text } from "@react-email/components"

const LOGO_URL = "https://openworklabs.com/email/openwork-mark.png"

export type OrganizationInviteEmailProps = {
  inviteLink: string
  invitedByName: string
  invitedByEmail: string
  organizationName: string
  role: string
}

export function OrganizationInviteEmail({
  inviteLink,
  invitedByName,
  invitedByEmail,
  organizationName,
  role,
}: OrganizationInviteEmailProps) {
  const inviter = invitedByEmail ? `${invitedByName} (${invitedByEmail})` : invitedByName

  return (
    <Html>
      <Head />
      <Preview>{invitedByName} invited you to join {organizationName} on OpenWork</Preview>
      <Body style={styles.body}>
        <Container style={styles.frame}>
          <Section style={styles.brand}>
            <Img src={LOGO_URL} width="31" height="24" alt="OpenWork" style={styles.brandLogo} />
            <span style={styles.brandName}>OpenWork</span>
          </Section>
          <Section style={styles.card}>
            <Text style={styles.eyebrow}>Invitation</Text>
            <Heading style={styles.heading}>Join {organizationName} on OpenWork</Heading>
            <Text style={styles.text}>
              {inviter} invited you to join the <span style={styles.strong}>{organizationName}</span> workspace as {articleFor(role)} {role}.
            </Text>
            <Button href={inviteLink} style={styles.button}>Accept invite</Button>
            <Hr style={styles.hr} />
            <Text style={styles.fallback}>If the button doesn&apos;t work, paste this link into your browser:</Text>
            <Text style={styles.link}>{inviteLink}</Text>
          </Section>
          <Text style={styles.footer}>
            You received this email because someone invited you to an OpenWork workspace.
            <br />
            OpenWork · openworklabs.com
          </Text>
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
    padding: "56px 0",
  },
  brand: {
    marginBottom: "20px",
    paddingLeft: "4px",
  },
  brandLogo: {
    display: "inline-block",
    verticalAlign: "middle",
  },
  brandName: {
    color: "#1C2024",
    fontSize: "15px",
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
  eyebrow: {
    color: "#60646C",
    fontSize: "12px",
    fontWeight: 500,
    letterSpacing: "0.08em",
    margin: "0 0 12px",
    textTransform: "uppercase",
  },
  heading: {
    color: "#1C2024",
    fontSize: "24px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    lineHeight: "32px",
    margin: "0 0 12px",
  },
  text: {
    color: "#60646C",
    fontSize: "15px",
    lineHeight: "24px",
    margin: "0 0 28px",
  },
  strong: {
    color: "#1C2024",
    fontWeight: 500,
  },
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
  hr: {
    borderColor: "#E1E4E8",
    margin: "32px 0 20px",
  },
  fallback: {
    color: "#60646C",
    fontSize: "13px",
    lineHeight: "20px",
    margin: "0 0 4px",
  },
  link: {
    color: "#3E63DD",
    fontSize: "13px",
    lineHeight: "20px",
    margin: 0,
    wordBreak: "break-all",
  },
  footer: {
    color: "#8B8D98",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "24px 0 0",
    paddingLeft: "4px",
  },
} satisfies Record<string, CSSProperties>
