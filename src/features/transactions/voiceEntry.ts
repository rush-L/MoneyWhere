// Turns a spoken sentence (English / Tagalog, as text from the browser's speech recognizer) into a PREFILLED form.
// It never saves: the user reviews the form and presses Add. Amount stays a string so parseTransaction/parseMinor remain the only parser.

export interface Named { id: string; name: string }
export interface VoiceFill {
  type: 'income' | 'expense' | 'transfer'
  amount: string // '' when no number was heard
  accountId: string
  destinationAccountId: string
  categoryId: string
  note: string
}

const INCOME = /(?<![\p{L}\p{N}])(income|salary|sweldo|suweldo|sahod|received|receive|natanggap|nakatanggap|kita)(?![\p{L}\p{N}])/iu
const TRANSFER = /(?<![\p{L}\p{N}])(transfer|move|lipat|ilipat|inilipat)(?![\p{L}\p{N}])/iu
const MONEY_WORDS = /(?<![\p{L}\p{N}])(php|pesos?|piso)(?![\p{L}\p{N}])|₱/giu
// Joining words trimmed from the edges of the leftover note.
const EDGE = /^(?:(?:for|on|to|from|at|sa|para|ng|mula|galing|papunta|papuntang|ang|ko|i|and|at)\s+)+|(?:\s+(?:for|on|to|from|at|sa|para|ng|mula|galing|papunta|papuntang|ang|ko))+$/iu

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(name)}(?![\\p{L}\\p{N}])`, 'iu')

/** Longest names first so "Food › Coffee" style child names beat a shorter parent. Returns the match and its position. */
function find(text: string, items: Named[]) {
  let best: { item: Named; index: number } | null = null
  for (const item of [...items].sort((a, b) => b.name.length - a.name.length)) {
    const m = item.name.trim() && wordRe(item.name.trim()).exec(text)
    if (m && (!best || item.name.length > best.item.name.length)) best = { item, index: m.index }
  }
  return best
}

export function parseVoice(spoken: string, accounts: Named[], categories: Named[]): VoiceFill {
  let rest = spoken.trim()
  const type = TRANSFER.test(rest) ? 'transfer' : INCOME.test(rest) ? 'income' : 'expense'
  rest = rest.replace(TRANSFER, ' ').replace(INCOME, ' ')

  // First number wins; "1,200.50" -> "1200.50". More than 2 decimals is passed through so parseTransaction rejects it, never rounds it.
  const num = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/.exec(rest)
  const amount = num ? num[0].replace(/,/g, '') : ''
  if (num) rest = rest.slice(0, num.index) + ' ' + rest.slice(num.index + num[0].length)
  rest = rest.replace(MONEY_WORDS, ' ')

  // Accounts: removed from the text one at a time. A transfer takes the first two in spoken order (from, then to).
  const picked: Named[] = []
  for (let i = 0; i < (type === 'transfer' ? 2 : 1); i++) {
    const hit = find(rest, accounts.filter((a) => !picked.includes(a)))
    if (!hit) break
    picked.push(hit.item)
    rest = rest.replace(wordRe(hit.item.name.trim()), ' ')
  }
  picked.sort((a, b) => spokenAt(spoken, a) - spokenAt(spoken, b))

  let categoryId = ''
  if (type === 'expense') {
    const hit = find(rest, categories)
    if (hit) {
      categoryId = hit.item.id
      rest = rest.replace(wordRe(hit.item.name.trim()), ' ')
    }
  }

  const note = rest.replace(/\s+/g, ' ').trim().replace(EDGE, '').trim()
  return { type, amount, accountId: picked[0]?.id ?? '', destinationAccountId: picked[1]?.id ?? '', categoryId, note: note.slice(0, 500) }
}

const spokenAt = (spoken: string, a: Named) => wordRe(a.name.trim()).exec(spoken)?.index ?? 0
