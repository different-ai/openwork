import { Body, Container, Head, Heading, Html, Preview, Section, Text } from "@react-email/components"

export type VerificationEmailProps = {
  verificationCode: string
}

export function VerificationEmail({ verificationCode }: VerificationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Your OpenWork verification code is {verificationCode}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.eyebrow}>OpenWork</Text>
          <Heading style={styles.heading}>Verify your email</Heading>
          <Text style={styles.text}>Enter this code to finish signing in to OpenWork.</Text>
          <Section style={styles.codeBox}>
            <Text style={styles.code}>{verificationCode}</Text>
          </Section>
          <Text style={styles.footer}>This code expires in 10 minutes. If you did not request it, you can ignore this email.</Text>
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
    maxWidth: "520px",
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
    margin: "0 0 16px",
  },
  text: {
    color: "#4d4640",
    fontSize: "16px",
    lineHeight: "24px",
    margin: "0 0 24px",
  },
  codeBox: {
    backgroundColor: "#171412",
    borderRadius: "16px",
    margin: "0 0 24px",
    padding: "22px",
    textAlign: "center" as const,
  },
  code: {
    color: "#fff8eb",
    fontSize: "34px",
    fontWeight: 700,
    letterSpacing: "0.18em",
    lineHeight: "40px",
    margin: 0,
  },
  footer: {
    color: "#756c62",
    fontSize: "14px",
    lineHeight: "21px",
    margin: 0,
  },
}
