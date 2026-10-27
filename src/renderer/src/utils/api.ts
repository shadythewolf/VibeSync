/**
 * Safe accessor for the preload bridge. `window.vibedeck` is always present inside
 * Electron, but the renderer can also be opened in a plain browser during development.
 */
import type { VibeDeckApi } from '@shared/ipc'

export function getApi(): VibeDeckApi | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { vibedeck?: VibeDeckApi }
  return w.vibedeck ?? null
}

export function hasApi(): boolean {
  return getApi() !== null
}

/** Log through the main process when available, otherwise to the devtools console. */
export function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: string): void {
  const api = getApi()
  if (api) {
    try {
      api.app.log(level, message, detail)
      return
    } catch {
      /* fall through */
    }
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  fn(`[vibedeck] ${message}`, detail ?? '')
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
