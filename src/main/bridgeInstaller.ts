/**
 * One-click install of the Spicetify bridge.
 *
 * Copies the bundled spicetify/vibesync-bridge.js into Spicetify's user data
 * Extensions folder (it survives Spicetify upgrades and takes priority over the
 * root folder), removes the legacy vibedeck-bridge.js entry, enables the bridge
 * and runs `spicetify apply`, falling back to `backup apply` (Spotify updated)
 * and `restore backup apply` (stale preprocessed data). No renderer input reaches a command.
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BridgeInstallResult, BridgeSetupStatus } from '../shared/types'
import { log } from './logger'

export const BRIDGE_FILE = 'vibesync-bridge.js'
const LEGACY_BRIDGE = 'vibedeck-bridge.js'
const COMMAND_TIMEOUT_MS = 120000

let installing: Promise<BridgeInstallResult> | null = null

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 *  dev:      <project>/spicetify/vibesync-bridge.js
 *  packaged: <install>/resources/spicetify/vibesync-bridge.js (electron-builder extraResources)
 */
export function getBundledBridgePath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'spicetify', BRIDGE_FILE)
  const candidates = [
    join(__dirname, '..', '..', 'spicetify', BRIDGE_FILE),
    join(app.getAppPath(), 'spicetify', BRIDGE_FILE),
    join(process.cwd(), 'spicetify', BRIDGE_FILE)
  ]
  return candidates.find(isFile) ?? candidates[0]
}

/** Version from the bridge header comment, e.g. "VibeSync 2.0.1 local Spotify ...". */
export function parseBridgeVersion(source: string): string | null {
  return source.slice(0, 300).match(/VibeSync (\d+\.\d+\.\d+)/)?.[1] ?? null
}

async function fileVersion(path: string): Promise<string | null> {
  try {
    return parseBridgeVersion(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Default install locations of the official Spicetify installers, then PATH. */
function spicetifyCandidates(): string[] {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return [join(local, 'spicetify', 'spicetify.exe'), 'spicetify.exe']
  }
  return [join(homedir(), '.spicetify', 'spicetify'), join(homedir(), '.local', 'bin', 'spicetify'), '/usr/bin/spicetify', 'spicetify']
}

// Spicetify colours its output; strip ANSI escapes before reading paths or errors.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

function run(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: stripAnsi(`${stdout}\n${stderr}`).trim() })
    })
  })
}

async function findSpicetify(): Promise<string | null> {
  for (const candidate of spicetifyCandidates()) {
    const bare = !candidate.includes('/') && !candidate.includes('\\')
    if (!bare && !isFile(candidate)) continue
    if ((await run(candidate, ['-v'])).ok) return candidate
  }
  return null
}

async function userExtensionsDir(spicetify: string): Promise<string | null> {
  const { ok, output } = await run(spicetify, ['path', 'userdata'])
  const dir = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
  return ok && dir ? join(dir, 'Extensions') : null
}

export async function getBridgeSetupStatus(): Promise<BridgeSetupStatus> {
  const bundledPath = getBundledBridgePath()
  const bundledVersion = await fileVersion(bundledPath)
  const spicetify = await findSpicetify()
  if (!spicetify) return { spicetifyFound: false, bundledVersion, installedVersion: null }
  const dir = await userExtensionsDir(spicetify)
  let installedVersion = dir ? await fileVersion(join(dir, BRIDGE_FILE)) : null
  if (!installedVersion) {
    // Older instructions copied the bridge into the root Extensions folder.
    const root = await run(spicetify, ['path', '-e', 'root'])
    const rootDir = root.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
    if (root.ok && rootDir) installedVersion = await fileVersion(join(rootDir, BRIDGE_FILE))
  }
  return { spicetifyFound: true, bundledVersion, installedVersion }
}

async function install(): Promise<BridgeInstallResult> {
  const spicetify = await findSpicetify()
  if (!spicetify) return { ok: false, message: 'Spicetify was not found. Install Spicetify first, then try again.' }
  const source = getBundledBridgePath()
  if (!isFile(source)) return { ok: false, message: `The bundled bridge is missing (${source}).` }
  const dir = await userExtensionsDir(spicetify)
  if (!dir) return { ok: false, message: 'Spicetify did not report its user data folder.' }

  await mkdir(dir, { recursive: true })
  await copyFile(source, join(dir, BRIDGE_FILE))
  log('info', 'Copied Spicetify bridge', join(dir, BRIDGE_FILE))

  // Removing an entry that is not configured is harmless, so the result is ignored.
  await run(spicetify, ['config', 'extensions', `${LEGACY_BRIDGE}-`])
  const enable = await run(spicetify, ['config', 'extensions', BRIDGE_FILE])
  if (!enable.ok) return { ok: false, message: 'Spicetify could not enable the bridge.', detail: enable.output }

  // After a Spotify update the backup no longer matches and Spicetify asks for
  // `backup apply`; stale preprocessed data needs `restore backup apply`.
  const attempts = [['apply'], ['backup', 'apply'], ['restore', 'backup', 'apply']]
  let applied = { ok: false, output: '' }
  for (const args of attempts) {
    applied = await run(spicetify, args)
    if (applied.ok) break
    log('warn', `spicetify ${args.join(' ')} failed`, applied.output)
  }
  if (!applied.ok) {
    log('error', 'Spicetify bridge install failed', applied.output)
    const reason = applied.output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^(error|warning)\b/i.test(line))
    return { ok: false, message: `Spicetify could not apply the changes${reason ? `: ${reason.replace(/^(error|warning)\s+/i, '')}` : '. Is Spotify Desktop installed?'}`, detail: applied.output }
  }
  const version = await fileVersion(source)
  log('info', `Spicetify bridge ${version ?? ''} installed`)
  return { ok: true, message: `Bridge ${version ?? ''} installed. Spotify restarts and connects automatically.`.replace('  ', ' ') }
}

/** Concurrent clicks share a single run. */
export function installBridge(): Promise<BridgeInstallResult> {
  installing ??= install()
    .catch((err: unknown): BridgeInstallResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) }))
    .finally(() => { installing = null })
  return installing
}
