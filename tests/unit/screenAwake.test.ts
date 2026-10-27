import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const blocker = vi.hoisted(() => ({ start: vi.fn(() => 0), stop: vi.fn() }))
vi.mock('electron', () => ({ powerSaveBlocker: blocker }))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))
import { installScreenAwake } from '../../src/main/screenAwake'

class TestWindow extends EventEmitter {
  focused = false
  visible = true
  minimized = false
  destroyed = false
  isFocused(): boolean { return this.focused }
  isVisible(): boolean { return this.visible }
  isMinimized(): boolean { return this.minimized }
  isDestroyed(): boolean { return this.destroyed }
}

beforeEach(() => vi.clearAllMocks())

describe('focused screen wake lock', () => {
  it('never starts merely because an unfocused window is open', () => {
    const win = new TestWindow()
    const guard = installScreenAwake(win as unknown as BrowserWindow, () => true)
    win.emit('show')
    expect(blocker.start).not.toHaveBeenCalled()
    guard.dispose()
  })

  it('starts once on focus and releases on blur, including blocker ID zero', () => {
    const win = new TestWindow()
    const guard = installScreenAwake(win as unknown as BrowserWindow, () => true)
    win.focused = true
    win.emit('focus')
    win.emit('show')
    guard.refresh()
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith('prevent-display-sleep')
    win.focused = false
    win.emit('blur')
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0)
    win.focused = true
    win.emit('focus')
    expect(blocker.start).toHaveBeenCalledTimes(2)
    guard.dispose()
  })

  it('releases on minimize and hide, even if focus still reports true', () => {
    const win = new TestWindow()
    win.focused = true
    const guard = installScreenAwake(win as unknown as BrowserWindow, () => true)
    win.minimized = true
    win.emit('minimize')
    expect(blocker.stop).toHaveBeenCalledTimes(1)
    win.minimized = false
    win.emit('restore')
    win.visible = false
    win.emit('hide')
    expect(blocker.stop).toHaveBeenCalledTimes(2)
    guard.dispose()
  })

  it('applies disabling immediately and starts again only when enabled and focused', () => {
    const win = new TestWindow()
    win.focused = true
    let enabled = true
    const guard = installScreenAwake(win as unknown as BrowserWindow, () => enabled)
    enabled = false
    guard.refresh()
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0)
    guard.refresh()
    expect(blocker.start).toHaveBeenCalledTimes(1)
    enabled = true
    guard.refresh()
    expect(blocker.start).toHaveBeenCalledTimes(2)
    guard.dispose()
  })

  it('releases and removes listeners on close or shutdown without restarting', () => {
    for (const close of [true, false]) {
      const win = new TestWindow()
      win.focused = true
      const guard = installScreenAwake(win as unknown as BrowserWindow, () => true)
      if (close) { win.destroyed = true; win.emit('closed') }
      else guard.dispose()
      const starts = blocker.start.mock.calls.length
      guard.refresh()
      guard.dispose()
      win.emit('focus')
      expect(blocker.start).toHaveBeenCalledTimes(starts)
      expect(win.listenerCount('focus')).toBe(0)
    }
    expect(blocker.stop).toHaveBeenCalledTimes(2)
  })
})
