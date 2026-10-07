// Map Supabase/network errors to safe user messages. Raw errors go to the console only.
const EXISTS = 'An account with this email already exists. Try signing in.'
export const RECOVERY_LINK_ERROR = 'This reset link is invalid or has expired.'
export const PASSWORD_UPDATED_NOTICE = 'Password updated. You can now sign in with your new password.'
export const RESET_REQUESTED_NOTICE = "If an account exists for that email, we've sent a reset link."

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
  otp_expired: RECOVERY_LINK_ERROR,
  same_password: 'Your new password must be different from your current password.',
  session_expired: 'Your reset session has expired. Request a new link.',
  session_not_found: 'Your reset session has expired. Request a new link.',
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
