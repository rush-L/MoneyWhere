// Map Supabase/network errors to safe user messages. Raw errors go to the console only.
const EXISTS = 'An account with this email already exists. Try signing in.'
const BY_CODE: Record<string, string> = {
  invalid_credentials: 'Incorrect email or password.',
  user_already_exists: EXISTS,
  email_exists: EXISTS,
  weak_password: 'That password is too weak. Use a longer, less common password.',
  email_not_confirmed: 'Please confirm your email first. Check your inbox.',
  signup_disabled: 'Sign-ups are currently disabled.',
  validation_failed: 'Please check the email and password you entered.',
  over_request_rate_limit: 'Too many attempts. Please wait a moment and try again.',
  over_email_send_rate_limit: 'Too many emails sent. Please wait a moment and try again.',
  provider_disabled: 'That sign-in method is not enabled.',
}
const NETWORK = 'Cannot reach the server. Check your connection and try again.'
const GENERIC = 'Something went wrong. Please try again.'

export function authErrorMessage(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null
  if (e && typeof e.code === 'string' && BY_CODE[e.code]) return BY_CODE[e.code]!
  if (e?.name === 'AuthRetryableFetchError') return NETWORK
  if (err instanceof TypeError && /fetch|network/i.test(String(e?.message))) return NETWORK
  return GENERIC
}
