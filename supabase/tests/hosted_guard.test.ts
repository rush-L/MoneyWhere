// Local only (no network, no hosted project): the fail-closed guard that every supabase/hosted script must pass.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APPROVED_DEV_REFS, checkHostedTarget } from '../hosted/guard.mjs'

const DEV = 'sitlhdkfihzmdzxfrliv'
const OTHER = 'abcdefghijklmnopqrst' // a well-formed ref that is not approved (stands in for any other project, e.g. production)
const url = (ref: string) => `https://${ref}.supabase.co`
const run = (envUrl: unknown, linkedRef: unknown, approved?: readonly string[]) => checkHostedTarget({ envUrl: envUrl as string, linkedRef: linkedRef as string, approved })

describe('hosted-suite safety guard', () => {
  it('accepts exactly the approved dev project when .env.local and the link agree', () => {
    expect(run(url(DEV), DEV)).toBe(DEV)
    expect(run(`  ${url(DEV)}  `, `${DEV}\n`)).toBe(DEV) // whitespace / trailing newline in the link file
    expect(APPROVED_DEV_REFS).toEqual([DEV])
  })

  it('rejects a mismatch between .env.local and the linked project, in either direction', () => {
    expect(() => run(url(DEV), OTHER)).toThrow(/different projects/)
    expect(() => run(url(OTHER), DEV)).toThrow(/different projects/)
  })

  it('rejects an unknown project even when .env.local and the link agree', () => {
    expect(() => run(url(OTHER), OTHER)).toThrow(/approved development list/)
  })

  it('has no way to approve another project from the environment: only an explicit in-code list changes the answer', () => {
    process.env.VITE_SUPABASE_URL = url(OTHER)
    process.env.SUPABASE_PROJECT_ID = OTHER
    try {
      expect(() => run(url(OTHER), OTHER)).toThrow(/approved development list/)
    } finally {
      delete process.env.VITE_SUPABASE_URL
      delete process.env.SUPABASE_PROJECT_ID
    }
    expect(run(url(OTHER), OTHER, [OTHER])).toBe(OTHER) // what a test passes in code; the scripts never pass a list
  })

  it('fails closed on missing, empty or unreadable inputs', () => {
    expect(() => run(undefined, DEV)).toThrow(/missing/)
    expect(() => run('', DEV)).toThrow(/missing/)
    expect(() => run('   ', DEV)).toThrow(/missing/)
    expect(() => run(url(DEV), undefined)).toThrow(/linked/)
    expect(() => run(url(DEV), '')).toThrow(/linked/)
    expect(() => run(url(DEV), 'not-a-ref')).toThrow(/linked/)
  })

  it('rejects malformed or look-alike URLs', () => {
    for (const bad of [
      'not a url',
      `http://${DEV}.supabase.co`, // not https
      `https://${DEV}.supabase.co:8443`, // port
      `https://user:pw@${DEV}.supabase.co`, // credentials
      `https://${DEV}.supabase.co.evil.example`, // suffix trick
      `https://evil.example/${DEV}.supabase.co`, // ref only in the path
      `https://${DEV}.supabase.com`, // wrong domain
      `https://${DEV}.supabase.co@evil.example`, // userinfo trick
      `https://${DEV.toUpperCase()}.supabase.co.attacker.test`,
      'https://localhost:54321', // local stack is not the approved hosted dev project
      `https://x${DEV}.supabase.co`, // 21 characters
    ]) {
      expect(() => run(bad, DEV), bad).toThrow(/Refusing/)
    }
  })

  it('every hosted script calls the guard before it does anything else', () => {
    const dir = new URL('../hosted/', import.meta.url)
    const scripts = readdirSync(dir).filter((n) => n.endsWith('.verify.ts') || n === 'cleanup.mjs')
    expect(scripts.length).toBeGreaterThanOrEqual(9)
    for (const name of scripts) {
      const src = readFileSync(new URL(name, dir), 'utf8')
      expect(src, `${name} imports the guard`).toMatch(/from '\.\/guard\.mjs'/)
      const call = src.search(/^(?:const target = )?assertDevProject\(\)/m)
      expect(call, `${name} calls assertDevProject()`).toBeGreaterThan(-1)
      // nothing that reads the environment, spawns the CLI or opens a client may come before the call
      expect(src.slice(0, call), `${name}: no hosted access before the guard`).not.toMatch(/readFileSync\(['"]\.env\.local|createClient\(|execFileSync\(|process\.argv/)
    }
  })
})
