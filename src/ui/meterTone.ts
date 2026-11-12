import type { BudgetThreshold } from '../domain/finance'

/** The one mapping from the domain's budget status (spec section 12: <80% normal, 80% to <100% warning, >=100% exceeded) to a meter colour. */
export const meterTone = (status: BudgetThreshold): 'ok' | 'near' | 'over' => (status === 'exceeded' ? 'over' : status === 'warning' ? 'near' : 'ok')
