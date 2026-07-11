import type { CSSProperties } from "react"
import { Body, Button, Container, Head, Heading, Html, Img, Preview, Section, Text } from "@react-email/components"

export type ConnectDesktopEmailProps = {
  organizationName: string
  connectUrl: string
  expiresAt: string
  logoUrl?: string | null
}

function formatExpiry(expiresAt: string): string {
  const parsed = new Date(expiresAt)
  if (Number.isNaN(parsed.getTime())) {
    return expiresAt
  }
  return parsed.toUTCString()
}

export function ConnectDesktopEmail({ organizationName, connectUrl, expiresAt, logoUrl }: ConnectDesktopEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Connect your OpenWork desktop to {organizationName}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.eyebrow}>OpenWork desktop</Text>
          {logoUrl ? <Img src={logoUrl} alt={`${organizationName} logo`} width="48" height="48" style={styles.logo} /> : null}
          <Heading style={styles.heading}>Connect your desktop to {organizationName}</Heading>
          <Text style={styles.text}>
            This link points your OpenWork desktop app at {organizationName}&apos;s server. Open it on the computer
            where OpenWork is installed, review what it will change, and confirm.
          </Text>

          <Button href={connectUrl} style={styles.button}>Connect your desktop</Button>

          <Section style={styles.noteBox}>
            <Text style={styles.note}>
              The link only configures the app — it never signs you in. After connecting, you still sign in with
              your {organizationName} account.
            </Text>
            <Text style={styles.note}>
              It expires on {formatExpiry(expiresAt)}. If the button does nothing, paste the link into
              OpenWork&apos;s connect screen instead.
            </Text>
          </Section>

          <Text style={styles.footer}>Didn&apos;t expect this email? You can safely ignore it — nothing changes until someone confirms inside the app.</Text>
        </Container>
      </Body>
    </Html>
  )
}

const styles = {
  body: {
    backgroundColor: "#f6f4ef",
    color: "#171412",
    fontFamily: "Arial, sans-serif",
    margin: 0,
  },
  container: {
    backgroundColor: "#fffdf8",
    border: "1px solid #e8dfd0",
    borderRadius: "20px",
    margin: "40px auto",
    maxWidth: "560px",
    padding: "32px",
  },
  eyebrow: {
    color: "#8a5a28",
    fontSize: "13px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    margin: "0 0 12px",
    textTransform: "uppercase",
  },
  logo: {
    borderRadius: "12px",
    marginBottom: "16px",
  },
  heading: {
    color: "#171412",
    fontSize: "28px",
    lineHeight: "34px",
    margin: "0 0 16px",
  },
  text: {
    color: "#4d4640",
    fontSize: "16px",
    lineHeight: "24px",
    margin: "0 0 24px",
  },
  button: {
    backgroundColor: "#171412",
    borderRadius: "999px",
    color: "#fff8eb",
    display: "inline-block",
    fontSize: "15px",
    fontWeight: 700,
    marginBottom: "24px",
    padding: "13px 22px",
    textDecoration: "none",
  },
  noteBox: {
    backgroundColor: "#f8f1e6",
    border: "1px solid #eadcc8",
    borderRadius: "16px",
    margin: "0 0 24px",
    padding: "20px",
  },
  note: {
    color: "#4d4640",
    fontSize: "14px",
    lineHeight: "21px",
    margin: "0 0 8px",
  },
  footer: {
    color: "#756c62",
    fontSize: "14px",
    lineHeight: "21px",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>
