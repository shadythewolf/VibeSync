import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  packaged: true,
  portable: false,
  files: new Set<string>(),
  sent: [] as Array<{ status: string; percent?: number; canInstall?: boolean }>,
  opened: [] as string[],
  quitting: false,
  remote: '9.9.9',
  available: true,
  failDownload: false,
  progress: null as null | ((p: { percent: number }) => void),
  quitAndInstall: vi.fn()
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.packaged }, getVersion: () => '2.2.0' },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_c: string, s: never) => mocks.sent.push(s) } }] },
  shell: { openExternal: async (url: string) => { mocks.opened.push(url) } }
}))
vi.mock('node:fs', () => ({ existsSync: (p: string) => [...mocks.files].some(f => p.replace(/\\/g, '/').endsWith(f)) }))
vi.mock('../../src/main/paths', () => ({ get isPortable() { return mocks.portable } }))
vi.mock('../../src/main/window', () => ({ setQuitting: (v: boolean) => { mocks.quitting = v } }))
vi.mock('../../src/main/logger', () => ({ log: vi.fn(), errorMessage: (e: unknown) => String(e instanceof Error ? e.message : e) }))
// Shaped like the bundled CommonJS import: autoUpdater only reachable through `default`.
vi.mock('electron-updater', () => ({
  default: { autoUpdater: {
    on: (event: string, cb: (p: { percent: number }) => void) => { if (event === 'download-progress') mocks.progress = cb },
    setFeedURL: vi.fn(),
    checkForUpdates: async () => ({ isUpdateAvailable: mocks.available, updateInfo: { version: mocks.remote } }),
    downloadUpdate: async () => {
      mocks.progress?.({ percent: 42.4 })
      if (mocks.failDownload) throw new Error('network down')
    },
    quitAndInstall: mocks.quitAndInstall
  } }
}))

type Updater = typeof import('../../src/main/updater')
let updater: Updater

beforeEach(async () => {
  vi.resetModules()
  Object.assign(mocks, { packaged: true, portable: false, sent: [], opened: [], quitting: false, available: true, failDownload: false })
  mocks.files = new Set(['resources/app-update.yml'])
  mocks.quitAndInstall.mockClear()
  Object.defineProperty(process, 'resourcesPath', { value: '/app/resources', configurable: true })
  delete process.env.APPIMAGE
  updater = await import('../../src/main/updater')
})

describe('updater', () => {
  it('needs a packaged build with a feed', async () => {
    mocks.packaged = false
    expect(updater.updatesConfigured()).toBe(false)
    expect((await updater.checkForUpdates()).status).toBe('not-configured')
  })

  it('knows which installs can replace themselves', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      expect(updater.canSelfInstall()).toBe(true)
      mocks.portable = true
      expect(updater.canSelfInstall()).toBe(false)
      mocks.portable = false
      Object.defineProperty(process, 'platform', { value: 'linux' })
      expect(updater.canSelfInstall()).toBe(false)
      process.env.APPIMAGE = '/home/me/VibeSync.AppImage'
      expect(updater.canSelfInstall()).toBe(true)
      delete process.env.APPIMAGE
      // install-linux.sh in extract-and-run mode: the runtime strips APPIMAGE, the launcher's copy survives.
      process.env.VIBESYNC_APPIMAGE = '/home/me/.local/share/vibesync/VibeSync.AppImage'
      process.env.VIBESYNC_EXTRACT_AND_RUN = '1'
      expect(updater.canSelfInstall()).toBe(true)
      expect(process.env.APPIMAGE).toBe('/home/me/.local/share/vibesync/VibeSync.AppImage')
      expect(process.env.APPIMAGE_EXTRACT_AND_RUN).toBe('1')
      for (const key of ['APPIMAGE', 'VIBESYNC_APPIMAGE', 'VIBESYNC_EXTRACT_AND_RUN', 'APPIMAGE_EXTRACT_AND_RUN']) delete process.env[key]
      mocks.files.add('resources/package-type')
      expect(updater.canSelfInstall()).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('reports an available update and pushes it to windows', async () => {
    const result = await updater.checkForUpdates()
    expect(result).toMatchObject({ status: 'available', version: '9.9.9' })
    expect(mocks.sent.map(s => s.status)).toEqual(['checking', 'available'])
  })

  it('reports up to date', async () => {
    mocks.available = false
    expect((await updater.checkForUpdates()).status).toBe('up-to-date')
  })

  it('downloads with progress, then installs after quitting', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await updater.checkForUpdates()
      await updater.downloadUpdate()
      expect(mocks.sent.some(s => s.status === 'downloading' && s.percent === 42)).toBe(true)
      expect(updater.getUpdateState().status).toBe('downloaded')
      await updater.installUpdate()
      expect(mocks.quitting).toBe(true)
      expect(mocks.quitAndInstall).toHaveBeenCalledWith(true, true)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('offers the download again when it fails', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      mocks.failDownload = true
      await updater.checkForUpdates()
      await updater.downloadUpdate()
      expect(updater.getUpdateState()).toMatchObject({ status: 'available' })
      expect(updater.getUpdateState().message).toContain('network down')
      await updater.installUpdate()
      expect(mocks.quitAndInstall).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('opens the release page for the portable build', async () => {
    mocks.portable = true
    await updater.checkForUpdates()
    await updater.downloadUpdate()
    expect(mocks.opened).toEqual([updater.RELEASES_URL])
  })
})
