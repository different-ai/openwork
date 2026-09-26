import { Body, Container, Head, Heading, Html, Preview, Section, Text } from "@react-email/components"

export type VerificationEmailPurpose = "sign-in" | "email-verification" | "forget-password" | "change-email"

export type VerificationEmailProps = {
  verificationCode: string
  /** Why the code was requested. Matches Better Auth's email OTP `type`. Defaults to email verification. */
  purpose?: VerificationEmailPurpose
}

const copyByPurpose: Record<VerificationEmailPurpose, { preview: string; heading: string; text: string }> = {
  "sign-in": {
    preview: "Your OpenWork sign-in code is",
    heading: "Sign in to OpenWork",
    text: "Enter this code to finish signing in to OpenWork.",
  },
  "email-verification": {
    preview: "Your OpenWork verification code is",
    heading: "Verify your email",
    text: "Enter this code to confirm your email address for OpenWork.",
  },
  "forget-password": {
    preview: "Your OpenWork password reset code is",
    heading: "Reset your password",
    text: "Enter this code to continue resetting your OpenWork password.",
  },
  "change-email": {
    preview: "Your OpenWork email change code is",
    heading: "Confirm your new email",
    text: "Enter this code to confirm the new email address for your OpenWork account.",
  },
}

export function verificationEmailSubject({ verificationCode, purpose }: VerificationEmailProps) {
  return `${copyByPurpose[purpose ?? "email-verification"].preview} ${verificationCode}`
}

export function VerificationEmail({ verificationCode, purpose }: VerificationEmailProps) {
  const copy = copyByPurpose[purpose ?? "email-verification"]
  return (
    <Html>
      <Head />
      <Preview>{copy.preview} {verificationCode}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.eyebrow}>OpenWork</Text>
          <Heading style={styles.heading}>{copy.heading}</Heading>
          <Text style={styles.text}>{copy.text}</Text>
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
