/* global URL */
// Fail-closed target check for everything under supabase/hosted (the *.verify.ts suites and cleanup.mjs).
// Those scripts create and delete real users, wallets and rows, so they may only ever touch the approved
// DEVELOPMENT project. Three things must all hold or the script refuses to run:
//   1. `.env.local` VITE_SUPABASE_URL is a plain https://<20-char-ref>.supabase.co URL,
//   2. the project linked for the Supabase CLI (supabase/.temp/project-ref) is that same project, and
//   3. that project is in APPROVED_DEV_REFS below.
// Anything missing, malformed, mismatched or unlisted is refused. A production project is never added to the list;
// production work uses an explicit `--project-ref` and never goes through these scripts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const APPROVED_DEV_REFS = Object.freeze(['sitlhdkfihzmdzxfrliv'])

const REF = /^[a-z0-9]{20}$/
const HOST = /^([a-z0-9]{20})\.supabase\.co$/

const refuse = (why) => {
  throw new Error(`Refusing to run against this Supabase project (hosted tests only run against the approved development project): ${why}`)
}

/** Pure check. Returns the approved project ref, or throws. `approved` is only overridable by callers in code (tests). */
export function checkHostedTarget({ envUrl, linkedRef, approved = APPROVED_DEV_REFS }) {
  if (typeof envUrl !== 'string' || !envUrl.trim()) refuse('VITE_SUPABASE_URL is missing from .env.local.')
  let url
  try {
    url = new URL(envUrl.trim())
  } catch {
    return refuse('VITE_SUPABASE_URL is not a valid URL.')
  }
  const m = HOST.exec(url.hostname)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !m) refuse('VITE_SUPABASE_URL is not a plain https://<project-ref>.supabase.co URL.')
  const envRef = m[1]
  const linked = typeof linkedRef === 'string' ? linkedRef.trim() : ''
  if (!REF.test(linked)) refuse('no linked Supabase project (supabase/.temp/project-ref) could be read.')
  if (envRef !== linked) refuse('.env.local and the linked Supabase project point at different projects.')
  if (!approved.includes(envRef)) refuse('the project is not on the approved development list (supabase/hosted/guard.mjs).')
  return envRef
}

const root = new URL('../../', import.meta.url)
const read = (rel) => {
  try {
    return readFileSync(fileURLToPath(new URL(rel, root)), 'utf8')
  } catch {
    return ''
  }
}

/** Reads `.env.local` and the CLI link from the repository and applies checkHostedTarget. Call before anything else. */
export function assertDevProject() {
  const envUrl = /^VITE_SUPABASE_URL=(.*)$/m.exec(read('.env.local'))?.[1]?.trim() ?? ''
  const linkedRef = read('supabase/.temp/project-ref').trim()
  return checkHostedTarget({ envUrl, linkedRef })
}
