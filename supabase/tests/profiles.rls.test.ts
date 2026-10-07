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

  it('anon sees nothing', async () => {
    const r = await as(null, () => db.query('select id from public.profiles'))
    expect(r.rows).toHaveLength(0)
  })

  it('rejects unsafe avatar URLs and over-long names', async () => {
    await expect(as(A, () => db.query(`update public.profiles set avatar_url = 'javascript:alert(1)' where id = $1`, [A]))).rejects.toThrow(/avatar_url_https/)
    await expect(as(A, () => db.query(`update public.profiles set display_name = $2 where id = $1`, [A, 'x'.repeat(51)]))).rejects.toThrow(/display_name_len/)
  })
})
