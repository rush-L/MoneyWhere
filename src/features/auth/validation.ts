export const MIN_PASSWORD = 8
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateEmail(email: string): string | null {
  return EMAIL.test(email.trim()) ? null : 'Enter a valid email address.'
}

export function validatePassword(password: string): string | null {
  return password.length >= MIN_PASSWORD ? null : `Password must be at least ${MIN_PASSWORD} characters.`
}

export function validateNewPassword(password: string, confirm: string): string | null {
  return validatePassword(password) ?? (password === confirm ? null : 'Passwords do not match.')
}
