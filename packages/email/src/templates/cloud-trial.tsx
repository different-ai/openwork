import React from "react"
import type { CSSProperties } from "react"
import { Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text } from "@react-email/components"

const LOGO_URL = "https://openworklabs.com/email/openwork-mark.png"

export type CloudTrialEmailProps = {
  phase: "ending" | "expired"
  organizationName: string
  expiresAt: string
  workspaceUrl: string
}

export function CloudTrialEmail({ phase, organizationName, expiresAt, workspaceUrl }: CloudTrialEmailProps) {
  const ending = phase === "ending"
  const title = ending ? "Your OpenWork cloud trial ends soon" : "Your OpenWork cloud trial has ended"
  const endDate = new Date(expiresAt).toLocaleString("en-US", {
    month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  })
  return (
    <Html>
      <Head />
      <Preview>{ending ? "Keep cloud work going with a paid plan. No automatic charge." : "Your saved work is retained. Resume cloud work whenever you choose a paid plan."}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Img src={LOGO_URL} width="31" height="24" alt="OpenWork" style={{ marginBottom: "28px" }} />
          <Text style={styles.eyebrow}>OPENWORK CLOUD</Text>
          <Heading style={styles.heading}>{title}</Heading>
          <Text style={styles.text}>
            {ending ? `Your 7-day trial for ${organizationName} ends on ${endDate}.` : `Your 7-day trial for ${organizationName} ended on ${endDate}.`}
          </Text>
          <Section style={styles.status}>
            <Text style={styles.statusTitle}>{ending ? "Your work stays with you." : "Your work is still here."}</Text>
            <Text style={styles.statusText}>
              {ending ? "When the trial ends, new cloud work pauses. Your saved work stays in your workspace." : "New cloud work is paused. Your saved work stays in your workspace."}
            </Text>
            <Text style={styles.statusText}>No payment will be taken automatically.</Text>
          </Section>
          <Text style={styles.text}>{ending ? "Choose a paid plan to keep working in the cloud after your trial." : "Choose a paid plan to resume cloud work with your workspace."}</Text>
          <Button href={workspaceUrl} style={styles.button}>Review cloud access</Button>
          <Text style={styles.caption}>Open your workspace, then review the plan. You decide whether to subscribe.</Text>
          <Hr style={styles.divider} />
          <Text style={styles.footer}>Prefer working locally? The OpenWork desktop app remains available for local work. Saved cloud work stays in your cloud workspace; it isn’t moved to your computer.</Text>
          <Text style={styles.footer}>Model-provider setup and charges are separate from cloud access.</Text>
          <Text style={styles.footer}>Choose {organizationName} from the workspace menu when you open OpenWork.</Text>
        </Container>
      </Body>
    </Html>
  )
}

const styles = {
  body: { margin: 0, padding: "24px 12px", backgroundColor: "#f5f5f5", fontFamily: "Arial, sans-serif", color: "#171717" },
  container: { backgroundColor: "#ffffff", padding: "28px 24px", margin: "0 auto", maxWidth: "520px", borderRadius: "16px" },
  eyebrow: { margin: "0 0 12px", fontSize: "11px", fontWeight: 700, letterSpacing: "1.5px", color: "#737373" },
  heading: { margin: "0 0 20px", fontSize: "29px", lineHeight: "35px", fontWeight: 600, letterSpacing: "-0.7px" },
  text: { margin: "0 0 20px", fontSize: "15px", lineHeight: "24px", color: "#525252" },
  status: { margin: "4px 0 24px", padding: "18px 20px", backgroundColor: "#f7f7f7", borderRadius: "12px" },
  statusTitle: { margin: "0 0 8px", fontSize: "15px", lineHeight: "22px", fontWeight: 600 },
  statusText: { margin: "6px 0 0", fontSize: "14px", lineHeight: "22px", color: "#525252" },
  button: { backgroundColor: "#171717", color: "#ffffff", borderRadius: "10px", padding: "14px 22px", fontSize: "14px", fontWeight: 600, textAlign: "center" },
  caption: { margin: "12px 0 0", fontSize: "12px", lineHeight: "19px", color: "#737373" },
  divider: { borderColor: "#eeeeee", margin: "26px 0 20px" },
  footer: { margin: "0 0 12px", fontSize: "12px", lineHeight: "20px", color: "#737373" },
} satisfies Record<string, CSSProperties>
