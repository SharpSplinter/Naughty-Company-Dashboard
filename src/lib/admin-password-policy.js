const MIN_ADMIN_PASSWORD_LENGTH = 8

/**
 * Validate the composition and simple-sequence rules for the administrator password.
 * @param {string} password
 * @returns {{ valid: true } | { valid: false, reason: string }}
 */
export function validateAdminPassword(password) {
  const characters = Array.from(password)
  if (characters.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return { valid: false, reason: `Use at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.` }
  }
  if (!/[A-Za-z]/.test(password)) {
    return { valid: false, reason: "Include at least one letter." }
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, reason: "Include at least one digit." }
  }
  if (!/[^A-Za-z0-9\\s]/.test(password)) {
    return { valid: false, reason: "Include at least one special character, such as punctuation." }
  }

  const normalized = Array.from(password.toLowerCase())
  const category = (character) => {
    if (/[0-9]/.test(character)) return "digit"
    if (/[a-z]/.test(character)) return "letter"
    return ""
  }
  for (let index = 0; index <= characters.length - 3; index++) {
    const first = normalized[index]
    const second = normalized[index + 1]
    const third = normalized[index + 2]
    const group = category(first)
    if (!group || category(second) !== group || category(third) !== group) continue
    const firstStep = second.charCodeAt(0) - first.charCodeAt(0)
    const secondStep = third.charCodeAt(0) - second.charCodeAt(0)
    if (firstStep === secondStep && (firstStep === 1 || firstStep === -1)) {
      return { valid: false, reason: "Avoid three or more consecutive letters or digits in sequence, such as abc, cba, 123, or 321." }
    }
  }

  return { valid: true }
}
