// Runs the REAL migrations and RLS policies in an in-process Postgres (PGlite).
// Stubs Supabase's `auth` schema (users table, auth.uid(), roles); it is NOT a hosted-Supabase test.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const dir = new URL('../migrations/', import.meta.url)
let db: PGlite

/** Run `fn` as an authenticated user (or anon when uid is null), then reset to superuser. */
async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema realtime; create table realtime.messages (topic text, extension text); alter table realtime.messages enable row level security;
    create table realtime.sent (topic text, event text, payload jsonb, private boolean);
    create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ insert into realtime.sent values (topic, event, payload, private) $$;
    grant usage on schema realtime to authenticated; grant select on realtime.messages to authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `)
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, dir), 'utf8'))
  }
  await db.exec(`
    insert into auth.users values ('${A}', 'a@x.test', '{"display_name":"Alice"}');
    insert into auth.users values ('${B}', 'b@x.test', '{"name":"Bob"}');
  `)
})

describe('profiles', () => {
  it('trigger creates a profile per new auth user, id = auth id', async () => {
    const r = await db.query<{ id: string; display_name: string }>('select id, display_name from public.profiles order by display_name')
    expect(r.rows).toEqual([{ id: A, display_name: 'Alice' }, { id: B, display_name: 'Bob' }])
  })

  it('A reads own profile only', async () => {
    const r = await as(A, () => db.query<{ id: string }>('select id from public.profiles'))
    expect(r.rows.map((x) => x.id)).toEqual([A])
    const other = await as(A, () => db.query('select id from public.profiles where id = $1', [B]))
    expect(other.rows).toHaveLength(0)
  })

  it('A updates own profile and updated_at moves', async () => {
    const before = await db.query<{ updated_at: string }>('select updated_at from public.profiles where id = $1', [A])
    await new Promise((r) => setTimeout(r, 5))
    const r = await as(A, () => db.query(`update public.profiles set display_name = 'Alicia', avatar_url = 'https://img.test/a.png' where id = $1`, [A]))
    expect(r.affectedRows).toBe(1)
    const after = await db.query<{ display_name: string; updated_at: string }>('select display_name, updated_at from public.profiles where id = $1', [A])
    expect(after.rows[0]?.display_name).toBe('Alicia')
    expect(new Date(after.rows[0]!.updated_at) > new Date(before.rows[0]!.updated_at)).toBe(true)
  })

  it('A cannot update B (0 rows, B unchanged)', async () => {
    const r = await as(A, () => db.query(`update public.profiles set display_name = 'Hacked' where id = $1`, [B]))
    expect(r.affectedRows).toBe(0)
    const b = await db.query<{ display_name: string }>('select display_name from public.profiles where id = $1', [B])
    expect(b.rows[0]?.display_name).toBe('Bob')
  })

  it('A cannot re-point own row at another id or touch protected columns', async () => {
    await expect(as(A, () => db.query('update public.profiles set id = $1 where id = $2', [B, A]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`update public.profiles set created_at = now() where id = $1`, [A]))).rejects.toThrow(/permission denied/)
  })

  it('clients cannot insert or delete profiles', async () => {
    await expect(as(A, () => db.query(`insert into public.profiles (id) values (gen_random_uuid())`))).rejects.toThrow()
    await expect(as(A, () => db.query('delete from public.profiles where id = $1', [A]))).rejects.toThrow(/permission denied/)
  })

  it('anon has no access at all', async () => {
    await expect(as(null, () => db.query('select id from public.profiles'))).rejects.toThrow(/permission denied/)
  })

  it('table privileges are exactly SELECT + column UPDATE for authenticated (no TRUNCATE/TRIGGER/REFERENCES)', async () => {
    const t = await db.query<{ g: string; p: string }>(
      `select grantee g, privilege_type p from information_schema.role_table_grants where table_schema='public' and table_name='profiles' and grantee in ('anon','authenticated') order by 1,2`)
    expect(t.rows).toEqual([{ g: 'authenticated', p: 'SELECT' }])
    const c = await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges where table_schema='public' and table_name='profiles' and grantee='authenticated' and privilege_type='UPDATE' order by 1`)
    expect(c.rows.map((r) => r.column_name)).toEqual(['avatar_url', 'display_name'])
    await expect(as(A, () => db.query('truncate public.profiles'))).rejects.toThrow(/permission denied/)
  })

  it('signup copies a valid OAuth avatar (picture / avatar_url) and drops unsafe ones without failing', async () => {
    const ids = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666']
    const metas = ['{"picture":"https://lh3.test/a.png"}', '{"avatar_url":"https://i.test/b.png"}', '{"picture":"javascript:alert(1)"}', '{"picture":"http://i.test/c.png"}']
    for (const [i, m] of metas.entries()) await db.query('insert into auth.users values ($1, $2, $3)', [ids[i], `u${i}@x.test`, m])
    const r = await db.query<{ avatar_url: string | null }>('select avatar_url from public.profiles where id = any($1) order by id', [ids])
    expect(r.rows.map((x) => x.avatar_url)).toEqual(['https://lh3.test/a.png', 'https://i.test/b.png', null, null])
  })

  it('signup normalises an over-long or blank provider name instead of failing, and leaves valid names alone', async () => {
    const long = 'Maria '.repeat(20) // 120 characters, trims to 119
    const cases: [string, Record<string, unknown>, string | null][] = [
      ['77777777-7777-4777-8777-777777777771', { name: long }, long.trim().slice(0, 50)],
      ['77777777-7777-4777-8777-777777777772', { display_name: 'y'.repeat(50) }, 'y'.repeat(50)],
      ['77777777-7777-4777-8777-777777777773', { display_name: 'z'.repeat(51) }, 'z'.repeat(50)],
      ['77777777-7777-4777-8777-777777777774', { name: '   ' }, null],
      ['77777777-7777-4777-8777-777777777775', { name: '' }, null],
      ['77777777-7777-4777-8777-777777777776', {}, null],
      ['77777777-7777-4777-8777-777777777777', { name: ' Ana Reyes ' }, ' Ana Reyes '], // within the limit: stored exactly as before
      ['77777777-7777-4777-8777-777777777778', { display_name: 'Display', name: 'Other' }, 'Display'], // display_name still wins over name
    ]
    for (const [i, [id, meta]] of cases.entries()) await db.query('insert into auth.users values ($1, $2, $3)', [id, `n${i}@x.test`, JSON.stringify(meta)])
    const r = await db.query<{ id: string; display_name: string | null }>('select id, display_name from public.profiles where id = any($1) order by id', [cases.map((c) => c[0])])
    expect(r.rows.map((x) => x.display_name)).toEqual(cases.map((c) => c[2]))
    expect(cases[0]![2]!.length).toBeLessThanOrEqual(50)
  })

  it('rejects unsafe avatar URLs and over-long names', async () => {
    await expect(as(A, () => db.query(`update public.profiles set avatar_url = 'javascript:alert(1)' where id = $1`, [A]))).rejects.toThrow(/avatar_url_https/)
    await expect(as(A, () => db.query(`update public.profiles set display_name = $2 where id = $1`, [A, 'x'.repeat(51)]))).rejects.toThrow(/display_name_len/)
  })
})
