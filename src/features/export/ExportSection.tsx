import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button } from '../../ui/Button'
import { Section } from '../../ui/Section'
import { useOffline } from '../offline/hooks/OfflineProvider'
import { downloadExport } from './downloadExport'
import { loadExport, type ExportProgress } from './exportService'

/** Online only: the file comes from fresh server reads, never from the device's offline copy. */
export function ExportSection({ userId }: { userId: string }) {
  const { online, items } = useOffline()
  const [busy, setBusy] = useState<ExportProgress | null>(null)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  async function run() {
    if (!supabase) return
    setMessage(null)
    setBusy({ done: 0, total: 1, label: 'Starting…' })
    try {
      const doc = await loadExport(supabase, userId, setBusy)
      downloadExport(doc)
      setMessage({ kind: 'ok', text: `Exported ${doc.counts.transactions} transactions from ${doc.counts.wallets} wallets.` })
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not export your data.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Export your data">
      <p className="note">
        Downloads one JSON file with your profile, your wallets and everything in them that you can see, including other current
        members&apos; transactions in shared wallets. It is created in your browser and sent nowhere. It contains financial data, so keep it safe.
      </p>
      {items.length > 0 && <p role="status" className="note">You have {items.length} unsynced change{items.length === 1 ? '' : 's'} on this device. Pending changes are not included in the export.</p>}
      {!online && <p role="status" className="note">Export needs an internet connection.</p>}
      {busy && <p role="status" className="note">{busy.label} ({busy.done}/{busy.total})</p>}
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'error' : 'note good'}>{message.text}</p>}
      <div className="actions">
        <Button variant="secondary" onClick={run} disabled={!online || !supabase || busy !== null}>{busy ? 'Exporting…' : 'Export my data'}</Button>
      </div>
    </Section>
  )
}
