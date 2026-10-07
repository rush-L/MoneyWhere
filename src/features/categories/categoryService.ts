import type { SupabaseClient } from '@supabase/supabase-js'
import { categoryFromRow, type Category, type CategoryRow } from './category'

/** Message is always safe to show to the user. */
export class CategoryError extends Error {}

function fail(message: string, err: unknown): never {
  console.error('[categories]', err)
  throw new CategoryError(message)
}

const isDuplicate = (e: { code?: string }) => e.code === '23505' // unique_violation on categories_wallet_name_key
const DUPLICATE = 'A category with that name already exists in this wallet.'

export function createCategoryService(client: SupabaseClient) {
  return {
    /** RLS limits rows to wallets the caller belongs to. */
    async list(walletId: string): Promise<Category[]> {
      const { data, error } = await client
        .from('categories')
        .select('id, wallet_id, parent_id, name')
        .eq('wallet_id', walletId)
        .returns<CategoryRow[]>()
      if (error) fail('Could not load categories. Please try again.', error)
      return data.map(categoryFromRow)
    },
    async create(walletId: string, name: string, parentId: string | null): Promise<void> {
      const { error } = await client
        .from('categories')
        .insert({ id: crypto.randomUUID(), wallet_id: walletId, parent_id: parentId, name })
      if (error) fail(isDuplicate(error) ? DUPLICATE : 'Could not create the category. Please try again.', error)
    },
    /** RLS hides rows from non-owners, so "no row updated" is reported as a permission problem. */
    async rename(c: Category, name: string): Promise<void> {
      const { data, error } = await client.from('categories').update({ name }).eq('id', c.id).select('id')
      if (error) fail(isDuplicate(error) ? DUPLICATE : 'Could not rename the category. Please try again.', error)
      if (data.length === 0) fail('Could not rename the category. Only the wallet owner can edit it.', 'no rows updated')
    },
    async remove(c: Category): Promise<void> {
      const { data, error } = await client.from('categories').delete().eq('id', c.id).select('id')
      if (error) {
        const msg = error.code === '23503' // foreign_key_violation: a transaction or budget references it (or a subcategory of it)
          ? 'This category has transaction history or a budget and cannot be deleted.'
          : 'Could not delete the category. Please try again.'
        fail(msg, error)
      }
      if (data.length === 0) fail('Could not delete the category. Only the wallet owner can delete it.', 'no rows deleted')
    },
  }
}
