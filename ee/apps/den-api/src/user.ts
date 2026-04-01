export function getRequiredUserEmail(user: { id: string; email?: string | null }) {
  const email = user.email?.trim()
  if (!email) {
    return null
  }

  return email
}
