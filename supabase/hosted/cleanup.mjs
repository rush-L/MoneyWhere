/* global process, console */
// Sweeps leftover hosted-test data (users + their wallets) from the DEV project. Dry-run by default.
//   node supabase/hosted/cleanup.mjs --project-ref=<ref>            list only
//   node supabase/hosted/cleanup.mjs --project-ref=<ref> --apply    delete what the list showed
// Safety (guard.mjs, fails closed): the project in .env.local, the linked project (supabase/.temp/project-ref) and
// the approved development list must all agree, and --project-ref must name that same project. Production is never
// accepted; this script is not for production. Matching is strict: only e-mails of the form the
// hosted suites generate (reambillo.russel+mw<letters><13-digit timestamp><suffix>@gmail.com). A wallet is deleted
// only if EVERY member is a matched test user; a user who belongs to any other wallet is kept. Nothing else is touched.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDevProject } from './guard.mjs'

const target = assertDevProject() // throws unless .env.local, the linked project and the approved dev list all agree
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1]
const apply = process.argv.includes('--apply')
const ref = arg('project-ref')
if (!ref || ref !== target) {
  console.error(`Refusing: --project-ref must be the approved development project (${target}).`)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'mwclean-'))
function sql(q) {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}

// Postgres regex; the same pattern the suites' addresses follow.
const TEST_EMAIL = "^reambillo[.]russel[+]mw[a-z]+[0-9]{13}[a-z0-9]{0,3}@gmail[.]com$"
const users = sql(`select id, email, created_at from auth.users where email ~ '${TEST_EMAIL}' order by created_at`)
const ids = users.map((u) => `'${u.id}'`).join(',') || `'00000000-0000-0000-0000-000000000000'`
// wallets that have at least one matched member, with how many members are NOT matched
const wallets = sql(`
  select w.id, w.name,
    (select count(*) from public.wallet_members m where m.wallet_id = w.id and m.user_id not in (${ids}))::int as foreign_members,
    (select count(*) from public.accounts a where a.wallet_id = w.id)::int as accounts,
    (select count(*) from public.transactions t where t.wallet_id = w.id)::int as transactions,
    (select count(*) from public.categories c where c.wallet_id = w.id)::int as categories,
    (select count(*) from public.budgets b where b.wallet_id = w.id)::int as budgets
  from public.wallets w
  where exists (select 1 from public.wallet_members m where m.wallet_id = w.id and m.user_id in (${ids}))
  order by w.name`)
const deletable = wallets.filter((w) => w.foreign_members === 0)
const kept = wallets.filter((w) => w.foreign_members > 0)
const keptIds = kept.map((w) => `'${w.id}'`).join(',') || `'00000000-0000-0000-0000-000000000000'`
const protectedUsers = sql(`select distinct user_id from public.wallet_members where wallet_id in (${keptIds}) and user_id in (${ids})`).map((r) => r.user_id)
const deletableUsers = users.filter((u) => !protectedUsers.includes(u.id))

console.log(`${apply ? 'APPLY' : 'DRY RUN'} on project ${ref}`)
console.log(`Test users matched: ${users.length}; to delete: ${deletableUsers.length} (profiles cascade)`)
for (const u of users) console.log(`  user ${u.id} ${u.email} ${protectedUsers.includes(u.id) ? 'KEEP (member of a wallet with non-test members)' : ''}`)
console.log(`Wallets with a test member: ${wallets.length}; to delete: ${deletable.length}`)
for (const w of wallets) console.log(`  wallet ${w.id} "${w.name}" accounts=${w.accounts} categories=${w.categories} transactions=${w.transactions} budgets=${w.budgets} ${w.foreign_members ? `KEEP (${w.foreign_members} non-test member(s))` : ''}`)

if (!apply) {
  console.log('Dry run only. Re-run with --apply to delete exactly the rows marked above (not KEEP).')
  process.exit(0)
}
if (deletable.length) sql(`delete from public.wallets where id in (${deletable.map((w) => `'${w.id}'`).join(',')})`)
if (deletableUsers.length) sql(`delete from auth.users where id in (${deletableUsers.map((u) => `'${u.id}'`).join(',')})`)
const left = sql(`select (select count(*) from auth.users where email ~ '${TEST_EMAIL}')::int users_left`)[0]
console.log('Deleted. Matched users remaining:', left.users_left)
