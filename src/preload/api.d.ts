import type { VibeDeckApi } from '../shared/ipc'

declare global {
  interface Window {
    vibedeck: VibeDeckApi
  }
}

export {}
