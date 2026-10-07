import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { useOffline } from '../offline/hooks/OfflineProvider'
import type { Wallet } from '../wallets/wallet'
import { groupCategories, parseCategoryName, type Category } from './category'
import { createCategoryService } from './categoryService'

export function CategoriesPage({ wallet, onBack }: { wallet: Wallet; onBack: () => void }) {
  const service = useMemo(() => (supabase ? createCategoryService(supabase) : null), [])
  const { online } = useOffline()
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')
  const [renaming, setRenaming] = useState<Category | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const isOwner = wallet.role === 'owner' // UX only; RLS enforces it

  const load = useCallback(
    () =>
      service?.list(wallet.id).then(
        (c) => {
          setCategories(c)
          setLoadError(null)
        },
        (e: Error) => setLoadError(e.message),
      ),
    [service, wallet.id],
  )

  useEffect(() => {
    if (online) void load() // no saved copy of categories: offline a request could only fail slowly
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
      {!online && !categories ? null : isOwner ? (
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
      ) : (
        <small>Only the wallet owner can manage categories.</small>
      )}
    </section>
  )
}
