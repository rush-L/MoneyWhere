import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { readThrough, type ReadResult } from '../offline/db/cache'
import { useOffline } from '../offline/hooks/OfflineProvider'
import { categoriesKey } from '../offline/localFinance'
import { staleNote } from '../offline/syncLabels'
import type { Wallet } from '../wallets/wallet'
import { groupCategories, parseCategoryName, type Category } from './category'
import { createCategoryService } from './categoryService'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field } from '../../ui/Field'
import { PageHeader } from '../../ui/PageHeader'
import { State } from '../../ui/State'

export function CategoriesPage({ wallet, userId }: { wallet: Wallet; userId: string }) {
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
  const [addOpen, setAddOpen] = useState(false) // dialog visibility only; the add form state above stays on this page
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
    void run(() => service!.create(wallet.id, parsed.name, parentId || null), () => { setName(''); setAddOpen(false) })
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
          <Field label={`Rename ${c.name}`}>
            <input value={renameValue} maxLength={50} onChange={(e) => setRenameValue(e.target.value)} disabled={busy} />
          </Field>
          <div className="actions">
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            <Button variant="ghost" onClick={() => setRenaming(null)} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )
    }
    return (
      <>
        <strong>{c.name}</strong>
        {isOwner && (
          confirmDelete === c.id ? (
            <>
              <small>{childCount > 0 ? `Also deletes its ${childCount} subcategories. ` : ''}Delete?</small>
              <div className="actions">
                <Button variant="danger" onClick={() => void run(() => service!.remove(c), () => setConfirmDelete(null))}>Confirm delete</Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              </div>
            </>
          ) : (
            <div className="actions">
              <Button variant="secondary" onClick={() => startRename(c)}>Rename</Button>
              <Button variant="ghost" className="text-danger" onClick={() => { setConfirmDelete(c.id); setFormError(null) }}>Delete</Button>
            </div>
          )
        )}
      </>
    )
  }

  const groups = categories ? groupCategories(categories) : []

  return (
    <>
      <PageHeader
        title="Categories"
        level={2}
        actions={isOwner ? <Button onClick={() => { setFormError(null); setAddOpen(true) }}>+ Add category</Button> : undefined}
      />
      {loadError && online && <State kind="error">{loadError}</State>}
      {stale && <p role="status" className="note">{staleNote(checking)}</p>}
      {!online && !categories && <State kind="empty">Categories aren't available offline yet. Connect to the internet to see them.</State>}
      {!categories && !loadError && online && <State kind="loading">Loading categories…</State>}
      {categories?.length === 0 && <State kind="empty">No categories yet.{isOwner ? ' Use + Add category to add your first one.' : ''}</State>}
      {groups.length > 0 && (
        <ul className="category-list">
          {groups.map((g) => (
            <li key={g.category.id} className="card category">
              <div className="cat-row">{row(g.category, g.children.length)}</div>
              {g.children.length > 0 && (
                <ul className="subcategory-list">
                  {g.children.map((c) => <li key={c.id} className="cat-row">{row(c)}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {formError && !addOpen && <p role="alert" className="error">{formError}</p>}
      {isOwner ? (
        <Dialog open={addOpen} onClose={() => setAddOpen(false)} dismissible={!busy} title="New category">
          <form onSubmit={add} noValidate>
            <Field label="Category name"><input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} disabled={busy} /></Field>
            <Field label="Parent">
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={busy}>
                <option value="">None (top-level)</option>
                {groups.map((g) => <option key={g.category.id} value={g.category.id}>{g.category.name}</option>)}
              </select>
            </Field>
            {formError && <p role="alert" className="error">{formError}</p>}
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add Category'}</Button>
          </form>
        </Dialog>
      ) : stale ? null : (
        <p className="note info">Only the wallet owner can manage categories.</p>
      )}
    </>
  )
}
