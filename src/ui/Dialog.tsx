import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from './Button'

/**
 * Container only. Children stay mounted while closed, so a parent that owns form state never loses it.
 * `dismissible` false (e.g. while saving) blocks Esc, backdrop click and the Close button.
 */
export function Dialog({ open, onClose, title, dismissible = true, children }: { open: boolean; onClose: () => void; title: string; dismissible?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={id}
      onCancel={(e) => { if (!dismissible) e.preventDefault() }}
      onClose={() => { if (open) onClose() }} // a programmatic close() after `open` went false must not call back
      onClick={(e) => { if (dismissible && e.target === e.currentTarget) onClose() }}
    >
      <div className="dialog-head">
        <h2 id={id}>{title}</h2>
        <Button variant="ghost" disabled={!dismissible} onClick={onClose}>Close</Button>
      </div>
      {children}
    </dialog>
  )
}
