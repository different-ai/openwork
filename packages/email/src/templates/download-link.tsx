import type { CSSProperties } from "react"
import { Body, Button, Container, Head, Heading, Html, Preview, Section, Text } from "@react-email/components"
import { desktopCapabilities } from "./desktop-capabilities.js"

export type DownloadLinkEmailProps = {
  organizationName?: string
  downloadUrl: string
}

export function DownloadLinkEmail({ organizationName, downloadUrl }: DownloadLinkEmailProps) {
  const intro = organizationName
    ? `Here's your link to download the OpenWork desktop app for ${organizationName}.`
    : "Here's your link to download the OpenWork desktop app."

  return (
    <Html>
      <Head />
      <Preview>Your OpenWork download link</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.eyebrow}>OpenWork desktop</Text>
          <Heading style={styles.heading}>Download OpenWork</Heading>
          <Text style={styles.text}>{intro}</Text>

          <Section style={styles.capabilitiesBox}>
            {desktopCapabilities.map((capability) => (
              <Text key={capability.title} style={styles.capability}>
                <strong>{capability.title}</strong> — {capability.description}
              </Text>
            ))}
          </Section>

          <Button href={downloadUrl} style={styles.button}>Download OpenWork</Button>
          <Text style={styles.footer}>Signing in inside the app syncs your team&apos;s shared skills.</Text>
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
  capabilitiesBox: {
    backgroundColor: "#f8f1e6",
    border: "1px solid #eadcc8",
    borderRadius: "16px",
    margin: "0 0 24px",
    padding: "20px",
  },
  capability: {
    color: "#4d4640",
    fontSize: "14px",
    lineHeight: "21px",
    margin: "0 0 8px",
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
  footer: {
    color: "#756c62",
    fontSize: "14px",
    lineHeight: "21px",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>
