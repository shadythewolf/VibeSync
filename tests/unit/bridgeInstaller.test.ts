import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  calls: [] as string[][],
  userdata: '',
  failApply: [] as string[],
  missing: false
}))

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
vi.mock('../../src/main/logger', () => ({ log: vi.fn() }))
// Fake Spicetify CLI: records every invocation and answers the commands the installer uses.
vi.mock('node:child_process', () => ({
  execFile: (_command: string, args: string[], _options: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => {
    mocks.calls.push(args)
    if (mocks.missing) return cb(new Error('ENOENT'), '', '')
    if (args[0] === 'path' && args[1] === 'userdata') return cb(null, `\x1b[32m${mocks.userdata}\x1b[0m\n`, '')
    if (args[0] === 'path') return cb(null, join(mocks.userdata, 'root-ext'), '')
    if (args.at(-1) === 'apply' && mocks.failApply.includes(args.join(' '))) return cb(new Error('exit 1'), '', 'Please run "spicetify backup apply"')
    cb(null, '', '')
  }
}))

import { getBridgeSetupStatus, installBridge, parseBridgeVersion } from '../../src/main/bridgeInstaller'

const bundled = readFileSync('spicetify/vibesync-bridge.js', 'utf8')
const bundledVersion = parseBridgeVersion(bundled)

beforeEach(() => {
  mocks.calls = []
  mocks.failApply = []
  mocks.missing = false
  mocks.userdata = mkdtempSync(join(tmpdir(), 'vibesync-spicetify-'))
  // Keep the default install location empty so the fake on PATH is used.
  process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'vibesync-local-'))
})

describe('Spicetify bridge installer', () => {
  it('reads the version from the bridge header', () => {
    expect(bundledVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(parseBridgeVersion('/* something else */')).toBeNull()
  })

  it('reports a missing Spicetify', async () => {
    mocks.missing = true
    expect(await getBridgeSetupStatus()).toEqual({ spicetifyFound: false, bundledVersion, installedVersion: null })
    expect((await installBridge()).ok).toBe(false)
  })

  it('copies the bridge, removes the legacy entry, enables and applies', async () => {
    expect((await getBridgeSetupStatus()).installedVersion).toBeNull()
    const result = await installBridge()
    expect(result.ok).toBe(true)
    expect(readFileSync(join(mocks.userdata, 'Extensions', 'vibesync-bridge.js'), 'utf8')).toBe(bundled)
    const commands = mocks.calls.filter(args => args[0] !== '-v' && args[0] !== 'path').map(args => args.join(' '))
    expect(commands).toEqual(['config extensions vibedeck-bridge.js-', 'config extensions vibesync-bridge.js', 'apply'])
    expect((await getBridgeSetupStatus()).installedVersion).toBe(bundledVersion)
  })

  it('runs backup apply after a Spotify update', async () => {
    mocks.failApply = ['apply']
    expect((await installBridge()).ok).toBe(true)
    expect(mocks.calls.at(-1)).toEqual(['backup', 'apply'])
  })

  it('falls back to restore backup apply', async () => {
    mocks.failApply = ['apply', 'backup apply']
    expect((await installBridge()).ok).toBe(true)
    expect(mocks.calls.at(-1)).toEqual(['restore', 'backup', 'apply'])
  })

  it('fails when every apply variant fails', async () => {
    mocks.failApply = ['apply', 'backup apply', 'restore backup apply']
    const result = await installBridge()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('backup apply')
  })

  it('finds an older bridge in the root Extensions folder', async () => {
    mkdirSync(join(mocks.userdata, 'root-ext'))
    writeFileSync(join(mocks.userdata, 'root-ext', 'vibesync-bridge.js'), '/* VibeSync 1.9.0 old bridge */')
    expect((await getBridgeSetupStatus()).installedVersion).toBe('1.9.0')
  })
})
