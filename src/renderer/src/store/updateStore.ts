import { create } from 'zustand'
import type { UpdateCheckResult } from '@shared/types'

export const useUpdateStore = create<{ state: UpdateCheckResult }>(() => ({ state: { status: 'idle' } }))
