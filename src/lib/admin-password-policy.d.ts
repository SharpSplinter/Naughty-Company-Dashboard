export type AdminPasswordValidation =
  | { valid: true }
  | { valid: false; reason: string }

export function validateAdminPassword(password: string): AdminPasswordValidation
