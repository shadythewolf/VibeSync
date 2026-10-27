/**
 * Main-process settings store: the single writer of <userData>/settings.json.
 *
 * - `load()` runs `validateSettings` over whatever is on disk (never throws; a corrupt
 *   file is backed up as settings.json.corrupt and defaults are restored).
 * - `set(patch)` deep-merges + validates, schedules an atomic save (tmp + rename, 150 ms
 *   debounce), broadcasts `settings:changed` to every window and notifies subscribers.
 *   Side effects (always-on-top, login item, tray, audio engine) are wired by index.ts
 *   through `subscribe()` so this module has no dependency on the services.
 */
import { BrowserWindow } from 'electron'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_SETTINGS,
  cloneSettings,
  mergeSettings,
  validateSettings,
  type DeepPartial,
  type Settings
} from '../shared/settings'
import type { AppError } from '../shared/types'
import { makeError } from './errors'
import { describeError, log } from './logger'
import { getSettingsPath } from './paths'

const SAVE_DEBOUNCE_MS = 150

export type SettingsListener = (next: Settings, prev: Settings) => void

class SettingsStore {
  private settings: Settings = cloneSettings(DEFAULT_SETTINGS)
  private loaded = false
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private listeners = new Set<SettingsListener>()
  private lastError: AppError | null = null
  /** Serialised form last confirmed on disk; `flushSync` writes only when it differs. */
  private lastWritten = ''
  private tmpSeq = 0

  /** Read settings.json (synchronously, once at startup). */
  load(): Settings {
    if (this.loaded) return this.settings
    const path = getSettingsPath()
    if (!existsSync(path)) {
      this.settings = cloneSettings(DEFAULT_SETTINGS)
      log('info', 'No settings file found; using defaults', path)
      this.scheduleSave()
    } else {
      try {
        const raw = readFileSync(path, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        this.settings = validateSettings(parsed)
        this.lastWritten = this.serialize()
        // Persist the normalised form when the file was hand-edited or from another version.
        if (JSON.stringify(this.settings) !== JSON.stringify(parsed)) this.scheduleSave()
        log('info', 'Settings loaded', path)
      } catch (err) {
        try {
          copyFileSync(path, path + '.corrupt')
        } catch {
          /* best effort backup */
        }
        this.settings = cloneSettings(DEFAULT_SETTINGS)
        this.lastError = makeError(
          'SETTINGS_IO',
          'The settings file was unreadable and has been reset to defaults.',
          undefined,
          describeError(err)
        )
        log('error', 'Settings file corrupt; defaults restored (backup: settings.json.corrupt)', err)
        this.scheduleSave()
      }
    }
    this.loaded = true
    return this.settings
  }

  get(): Settings {
    return this.settings
  }

  /** Last persistence error, if any (surfaced through the log; kept for diagnostics). */
  getLastError(): AppError | null {
    return this.lastError
  }

  set(patch: DeepPartial<Settings>): Settings {
    const prev = this.settings
    const next = mergeSettings(prev, patch)
    if (JSON.stringify(next) === JSON.stringify(prev)) return prev
    this.commit(next, prev)
    return next
  }

  /** Restore defaults but keep `firstRunCompleted` so the setup dialog does not reappear. */
  reset(): Settings {
    const prev = this.settings
    const next = cloneSettings(DEFAULT_SETTINGS)
    next.general.firstRunCompleted = true
    this.commit(next, prev)
    log('info', 'Settings reset to defaults')
    return next
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Write pending changes synchronously (shutdown path).
   *
   * Keyed on what is actually on disk rather than the `dirty` flag: `saveNow()` clears
   * `dirty` before its asynchronous write completes, so a quit landing in that window
   * would otherwise drop the change.
   */
  flushSync(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const data = this.serialize()
    this.dirty = false
    if (data === this.lastWritten) return
    const path = getSettingsPath()
    const tmp = this.tmpPath(path)
    try {
      writeFileSync(tmp, data, 'utf8')
      renameSync(tmp, path)
      this.lastWritten = data
    } catch (err) {
      log('error', 'Could not save settings (sync)', err)
    }
  }

  /** Unique temp name per write so a sync flush can never collide with an in-flight write. */
  private tmpPath(path: string): string {
    this.tmpSeq += 1
    return `${path}.${process.pid}-${this.tmpSeq}.tmp`
  }

  private commit(next: Settings, prev: Settings): void {
    this.settings = next
    this.scheduleSave()
    this.broadcast(next)
    for (const l of this.listeners) {
      try {
        l(next, prev)
      } catch (err) {
        log('error', 'Settings listener threw', err)
      }
    }
  }

  private broadcast(settings: Settings): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(IPC.settingsChanged, settings)
      } catch (err) {
        log('warn', 'settings:changed broadcast failed', err)
      }
    }
  }

  private serialize(): string {
    return JSON.stringify(this.settings, null, 2)
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private saveNow(): void {
    if (!this.dirty) return
    this.dirty = false
    const data = this.serialize()
    const path = getSettingsPath()
    const tmp = this.tmpPath(path)
    this.writeChain = this.writeChain
      .then(async () => {
        if (data === this.lastWritten) return
        await writeFile(tmp, data, 'utf8')
        await rename(tmp, path)
        this.lastWritten = data
      })
      .catch((err: unknown) => {
        this.lastError = makeError('SETTINGS_IO', 'Settings could not be saved.', undefined, describeError(err))
        log('error', 'Could not save settings', err)
      })
  }
}

export const settingsStore = new SettingsStore()
export type { SettingsStore }
