import React from "react"
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components"

export type CloudTrialEmailProps = {
  phase: "ending" | "expired"
  organizationName: string
  expiresAt: string
  workspaceUrl: string
}

export function CloudTrialEmail({ phase, organizationName, expiresAt, workspaceUrl }: CloudTrialEmailProps) {
  const title = phase === "ending" ? "Your OpenWork cloud trial ends soon" : "Your OpenWork cloud trial has ended"
  return <Html><Head /><Preview>{title}</Preview>
    <Body style={{ backgroundColor: "#f5f5f5", fontFamily: "Arial, sans-serif", color: "#171717" }}>
      <Container style={{ backgroundColor: "#ffffff", padding: "32px", margin: "40px auto", maxWidth: "520px", borderRadius: "20px" }}>
        <Text>OpenWork · {organizationName}</Text><Heading>{title}</Heading>
        <Text>{phase === "ending" ? `Cloud access pauses on ${new Date(expiresAt).toUTCString()}.` : "Cloud access is now paused."} Your saved work stays in your workspace.</Text>
        <Text>No payment will be taken. Choose a paid plan if you want to keep using cloud access. The desktop app remains available, and model access keeps its existing setup and pricing.</Text>
        <Button href={workspaceUrl} style={{ backgroundColor: "#171717", color: "white", borderRadius: "12px", padding: "14px 20px" }}>Review cloud access</Button>
        <Text>Choose {organizationName} from the workspace menu when you open OpenWork.</Text>
      </Container>
    </Body>
  </Html>
}
