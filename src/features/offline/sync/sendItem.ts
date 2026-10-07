import type { createTransactionService } from '../../transactions/transactionService'
import type { OutboxItem } from '../outbox/outbox'
import { IntegrityError } from './errors'

type Svc = Pick<ReturnType<typeof createTransactionService>, 'send' | 'mutate'>

/**
 * Sends one outbox item. CREATE is the Phase 9 idempotent insert. UPDATE/DELETE go through the version-aware RPC,
 * always own-only (offline never touches another user's row). Lost responses are safe: the item keeps its
 * mutation_id, so the server answers ALREADY_APPLIED instead of a false conflict.
 */
export async function sendItem(svc: Svc, i: OutboxItem): Promise<'ok' | 'conflict'> {
  if (i.op === 'CREATE') {
    await svc.send(i.id, i.user_id, i.payload!)
    return 'ok'
  }
  if (!i.mutation_id) throw new IntegrityError(`Queued ${i.op} for ${i.id} has no mutation id; not sent.`)
  const r = await svc.mutate({ mutationId: i.mutation_id, op: i.op, id: i.id, expectedVersion: i.expected_version, payload: i.payload, ownOnly: true })
  if (r.status === 'CONFLICT') return 'conflict'
  if (r.status === 'FORBIDDEN') throw new IntegrityError(`Transaction ${i.id} is not yours to change; not applied.`)
  return 'ok' // APPLIED, ALREADY_APPLIED, ALREADY_GONE
}
