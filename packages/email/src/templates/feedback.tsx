import { Body, Container, Head, Heading, Hr, Html, Preview, Section, Text } from "@react-email/components"

export type FeedbackEmailProps = {
  name: string
  email: string
  message: string
  source: string
  entrypoint: string
  deployment: string
  appVersion: string
  openworkServerVersion: string
  opencodeVersion: string
  orchestratorVersion: string
  opencodeRouterVersion: string
  osName: string
  osVersion: string
  platform: string
  diagnosticsSummary: string
  submittedAt: string
}

export function FeedbackEmail({
  name,
  email,
  message,
  source,
  entrypoint,
  deployment,
  appVersion,
  openworkServerVersion,
  opencodeVersion,
  orchestratorVersion,
  opencodeRouterVersion,
  osName,
  osVersion,
  platform,
  diagnosticsSummary,
  submittedAt,
}: FeedbackEmailProps) {
  const osLabel = [osName, osVersion].filter(Boolean).join(" ")
  const metadata = [
    ["Source", source],
    ["Entrypoint", entrypoint],
    ["Deployment", deployment],
    ["App version", appVersion],
    ["OpenWork server", openworkServerVersion],
    ["OpenCode", opencodeVersion],
    ["Orchestrator", orchestratorVersion],
    ["Router", opencodeRouterVersion],
    ["OS", osLabel],
    ["Platform", platform],
    ["Submitted", submittedAt],
  ].filter(([, value]) => value)

  return (
    <Html>
      <Head />
      <Preview>{name} sent OpenWork feedback from {entrypoint || source || "unknown"}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.eyebrow}>OpenWork feedback</Text>
          <Heading style={styles.heading}>Feedback from {name}</Heading>
          <Text style={styles.contact}>{email}</Text>

          <Section style={styles.messageBox}>
            <Text style={styles.message}>{message}</Text>
          </Section>

          <Hr style={styles.hr} />
          <Text style={styles.sectionTitle}>Context</Text>
          {metadata.map(([label, value]) => (
            <Text key={label} style={styles.metaLine}>
              <strong>{label}:</strong> {value}
            </Text>
          ))}

          {diagnosticsSummary ? (
            <>
              <Hr style={styles.hr} />
              <Text style={styles.sectionTitle}>Diagnostics summary</Text>
              <Text style={styles.diagnostics}>{diagnosticsSummary}</Text>
            </>
          ) : null}
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
    maxWidth: "620px",
    padding: "32px",
  },
  eyebrow: {
    color: "#8a5a28",
    fontSize: "13px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    margin: "0 0 12px",
    textTransform: "uppercase" as const,
  },
  heading: {
    color: "#171412",
    fontSize: "28px",
    lineHeight: "34px",
    margin: "0 0 8px",
  },
  contact: {
    color: "#756c62",
    fontSize: "14px",
    lineHeight: "21px",
    margin: "0 0 24px",
  },
  messageBox: {
    backgroundColor: "#171412",
    borderRadius: "16px",
    margin: "0 0 24px",
    padding: "20px",
  },
  message: {
    color: "#fff8eb",
    fontSize: "16px",
    lineHeight: "24px",
    margin: 0,
    whiteSpace: "pre-wrap" as const,
  },
  hr: {
    borderColor: "#e8dfd0",
    margin: "24px 0 18px",
  },
  sectionTitle: {
    color: "#171412",
    fontSize: "15px",
    fontWeight: 700,
    margin: "0 0 10px",
  },
  metaLine: {
    color: "#4d4640",
    fontSize: "14px",
    lineHeight: "21px",
    margin: "0 0 6px",
  },
  diagnostics: {
    color: "#4d4640",
    fontFamily: "Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "18px",
    margin: 0,
    whiteSpace: "pre-wrap" as const,
  },
}
