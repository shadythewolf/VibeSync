import { powerSaveBlocker, type BrowserWindow } from 'electron'
import { log } from './logger'

/** Hold the display awake only while the main window is actually in focus. */
export function installScreenAwake(win: BrowserWindow, enabled: () => boolean): { refresh: () => void; dispose: () => void } {
  let blocker: number | null = null
  let disposed = false
  const release = (): void => {
    if (blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
  }
  const refresh = (): void => {
    if (disposed || win.isDestroyed() || !enabled() || !win.isFocused() || !win.isVisible() || win.isMinimized()) {
      release()
      return
    }
    if (blocker === null) {
      try {
        blocker = powerSaveBlocker.start('prevent-display-sleep')
      } catch (err) {
        log('warn', 'Could not keep the focused display awake', err)
      }
    }
  }
  const dispose = (): void => {
    disposed = true
    win.removeListener('focus', refresh)
    win.removeListener('blur', refresh)
    win.removeListener('show', refresh)
    win.removeListener('hide', refresh)
    win.removeListener('minimize', refresh)
    win.removeListener('restore', refresh)
    win.removeListener('closed', dispose)
    release()
  }
  win.on('focus', refresh)
  win.on('blur', refresh)
  win.on('show', refresh)
  win.on('hide', refresh)
  win.on('minimize', refresh)
  win.on('restore', refresh)
  win.on('closed', dispose)
  refresh()
  return { refresh, dispose }
}
