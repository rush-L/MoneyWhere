import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { readThrough, type ReadResult } from '../offline/db/cache'
import { useOffline } from '../offline/hooks/OfflineProvider'
import { categoriesKey } from '../offline/localFinance'
import { staleNote } from '../offline/syncLabels'
import type { Wallet } from '../wallets/wallet'
import { groupCategories, parseCategoryName, type Category } from './category'
import { createCategoryService } from './categoryService'

export function CategoriesPage({ wallet, userId, onBack }: { wallet: Wallet; userId: string; onBack: () => void }) {
  const service = useMemo(() => (supabase ? createCategoryService(supabase) : null), [])
  const { online, cache } = useOffline()
  const seq = useRef(0) // newest load wins
  const initial = useRef(true) // first load may show the saved snapshot while revalidating; reloads after a write may not
  const [stale, setStale] = useState(false) // showing the saved snapshot (not confirmed by the server)
  const [checking, setChecking] = useState(false)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')
  const [renaming, setRenaming] = useState<Category | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const isOwner = wallet.role === 'owner' && !stale // UX only; RLS enforces it. Never edit from an unconfirmed snapshot

  const load = useCallback(
    (swr = false) => {
      if (!service) return
      const n = ++seq.current
      const apply = (r: ReadResult<Category[]>) => {
        if (n !== seq.current) return
        setCategories(r.data)
        setStale(r.stale)
        setChecking(!!r.revalidating)
        setLoadError(null)
      }
      return readThrough(cache, categoriesKey(userId, wallet.id), () => service.list(wallet.id), swr ? apply : undefined).then(
        apply,
        (e: Error) => n === seq.current && setLoadError(e.message),
      )
    },
    [service, wallet.id, userId, cache],
  )

  useEffect(() => {
    // offline: readThrough answers from the snapshot without a request, or fails at once when there is none
    void load(initial.current)
    initial.current = false
  }, [load, online])

  /** Runs a write, then reloads. Errors show next to the forms. */
  async function run(action: () => Promise<void>, after: () => void) {
    setBusy(true)
    setFormError(null)
    try {
      await action()
      after()
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  function add(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseCategoryName(name)
    if (!parsed.ok) return setFormError(parsed.error)
    void run(() => service!.create(wallet.id, parsed.name, parentId || null), () => setName(''))
  }

  function saveRename(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseCategoryName(renameValue)
    if (!parsed.ok) return setFormError(parsed.error)
    void run(() => service!.rename(renaming!, parsed.name), () => setRenaming(null))
  }

  function startRename(c: Category) {
    setRenaming(c)
    setRenameValue(c.name)
    setFormError(null)
    setConfirmDelete(null)
  }

  function row(c: Category, childCount = 0) {
    if (renaming?.id === c.id) {
      return (
        <form onSubmit={saveRename} noValidate>
          <label>
            Rename {c.name}
            <input value={renameValue} maxLength={50} onChange={(e) => setRenameValue(e.target.value)} disabled={busy} />
          </label>
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="link" onClick={() => setRenaming(null)} disabled={busy}>Cancel</button>
        </form>
      )
    }
    return (
      <>
        <strong>{c.name}</strong>
        {isOwner && (
          <>
            {' '}<button type="button" className="link" onClick={() => startRename(c)}>Rename</button>
            {confirmDelete === c.id ? (
              <>
                {' '}<small>{childCount > 0 ? `Also deletes its ${childCount} subcategories. ` : ''}Delete?</small>
                {' '}<button type="button" className="link" onClick={() => void run(() => service!.remove(c), () => setConfirmDelete(null))}>Confirm delete</button>
                {' '}<button type="button" className="link" onClick={() => setConfirmDelete(null)}>Cancel</button>
              </>
            ) : (
              <>{' '}<button type="button" className="link" onClick={() => { setConfirmDelete(c.id); setFormError(null) }}>Delete</button></>
            )}
          </>
        )}
      </>
    )
  }

  const groups = categories ? groupCategories(categories) : []

  return (
    <section className="card">
      <button type="button" className="link" onClick={onBack}>← Wallets</button>
      <h2>{wallet.name} · Categories</h2>
      {loadError && online && <p role="alert" className="error">{loadError}</p>}
      {stale && <p role="status"><small>{staleNote(checking)}</small></p>}
      {!online && !categories && <p role="status">Categories aren't available offline yet. Connect to the internet to see them.</p>}
      {!categories && !loadError && online && <p role="status">Loading categories…</p>}
      {categories?.length === 0 && <p>No categories yet.{isOwner ? ' Add your first one below.' : ''}</p>}
      {groups.length > 0 && (
        <ul className="list">
          {groups.map((g) => (
            <li key={g.category.id}>
              {row(g.category, g.children.length)}
              {g.children.length > 0 && (
                <ul>
                  {g.children.map((c) => <li key={c.id}>{row(c)}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {formError && <p role="alert" className="error">{formError}</p>}
      {isOwner ? (
        <form onSubmit={add} noValidate>
          <strong>New category</strong>
          <label>Category name<input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
          <label>
            Parent
            <select value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={busy}>
              <option value="">None (top-level)</option>
              {groups.map((g) => <option key={g.category.id} value={g.category.id}>{g.category.name}</option>)}
            </select>
          </label>
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add Category'}</button>
        </form>
      ) : stale ? null : (
        <small>Only the wallet owner can manage categories.</small>
      )}
    </section>
  )
}
