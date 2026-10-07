import { defineConfig } from 'vitest/config'

// Hosted verification only; deliberately separate from `npm test`.
export default defineConfig({ test: { include: ['supabase/hosted/*.verify.ts'], fileParallelism: false, testTimeout: 60_000 } })
