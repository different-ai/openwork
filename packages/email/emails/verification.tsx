import { VerificationEmail, type VerificationEmailProps } from "../src/templates/verification"

export default function VerificationPreview(props: VerificationEmailProps) {
  return <VerificationEmail {...props} />
}

VerificationPreview.PreviewProps = {
  verificationCode: "123456",
  recoveryUrl: "https://app.openworklabs.com/verify?email=member%40example.test",
} satisfies VerificationEmailProps
