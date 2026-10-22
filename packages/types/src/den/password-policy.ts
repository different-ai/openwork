// Shared by server validation and password-entry guidance.
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 32
export const MIN_PASSWORD_STRENGTH_SCORE = 3

export const PASSWORD_COMPOSITION_RULES = {
  uppercase: { required: true, pattern: /[A-Z]/u, hint: "an uppercase letter (A–Z)" },
  lowercase: { required: true, pattern: /[a-z]/u, hint: "a lowercase letter (a–z)" },
  digit: { required: true, pattern: /[0-9]/u, hint: "a number (0–9)" },
  special: { required: true, pattern: /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u, hint: "a special character" },
}

export function getPasswordPolicyHint(): string {
  const requirements = Object.values(PASSWORD_COMPOSITION_RULES).filter(rule => rule.required).map(rule => rule.hint)
  const composition = new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" }).format(requirements)
  const strength = MIN_PASSWORD_STRENGTH_SCORE > 0 ? " Avoid common words or patterns; password strength is also checked." : ""
  return `Use ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters${composition ? `, with ${composition}` : ""}.${strength}`
}
