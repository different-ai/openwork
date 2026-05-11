import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Text } from "@react-email/components"

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
        <Container style={styles.container}>
          <Text style={styles.eyebrow}>OpenWork invite</Text>
          <Heading style={styles.heading}>Join {organizationName}</Heading>
          <Text style={styles.text}>{inviter} invited you to join {organizationName} as {articleFor(role)} {role}.</Text>
          <Button href={inviteLink} style={styles.button}>Accept invite</Button>
          <Hr style={styles.hr} />
          <Text style={styles.footer}>If the button does not work, paste this link into your browser:</Text>
          <Text style={styles.link}>{inviteLink}</Text>
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
  button: {
    backgroundColor: "#171412",
    borderRadius: "999px",
    color: "#fff8eb",
    display: "inline-block",
    fontSize: "15px",
    fontWeight: 700,
    padding: "13px 22px",
    textDecoration: "none",
  },
  hr: {
    borderColor: "#e8dfd0",
    margin: "28px 0 18px",
  },
  footer: {
    color: "#756c62",
    fontSize: "14px",
    lineHeight: "21px",
    margin: "0 0 8px",
  },
  link: {
    color: "#5b3a18",
    fontSize: "13px",
    lineHeight: "19px",
    margin: 0,
    wordBreak: "break-all" as const,
  },
}
