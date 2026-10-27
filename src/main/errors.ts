/**
 * AppError construction and the user-facing hints for every ErrorCode.
 */
import type { AppError, ErrorCode } from '../shared/types'

export const HINTS: Record<ErrorCode, string> = {
  HELPER_MISSING: 'Reinstall VibeSync; the helper is shipped in resources\\helper.',
  HELPER_START_FAILED:
    'Check that your antivirus is not blocking VibeDeckHelper.exe, then restart VibeSync. Switch the audio engine to Chromium loopback in Settings > Audio as a workaround.',
  HELPER_CRASHED:
    'VibeSync will retry automatically. If it keeps failing, switch the audio engine to Chromium loopback in Settings > Audio and check the log file (Settings > About > Open logs).',
  HELPER_PROTOCOL: 'The helper and VibeSync are out of sync. Reinstall VibeSync so both components match.',
  DOTNET_MISSING: 'Install .NET Framework 4.8 from Microsoft (Windows 11 includes it).',
  CAPTURE_INIT_FAILED:
    'Check that a playback device is enabled in Windows Sound settings and that no app is using it in exclusive mode.',
  DEVICE_NOT_FOUND: 'The selected device is unavailable; VibeSync is using the Windows default output instead. Pick another device in Settings > Audio.',
  DEVICE_DISCONNECTED: 'The device was removed; VibeSync switched to the Windows default output.',
  NO_AUDIO_DEVICE: 'Connect or enable speakers/headphones in Windows Sound settings.',
  BROWSER_CAPTURE_FAILED:
    'Chromium could not capture system audio. Switch the audio engine to Native helper in Settings > Audio, or restart VibeSync.',
  BROWSER_CAPTURE_DENIED:
    'Allow screen/system audio capture when prompted, or switch the audio engine to Native helper in Settings > Audio.',
  UNSUPPORTED_PLATFORM: 'VibeSync captures system audio with Windows WASAPI and only runs on Windows 10/11.',
  SETTINGS_IO: 'Check that the VibeSync data folder is writable (Settings > About > Open data folder).',
  RENDERER_CRASH: 'The window will reload automatically. If this repeats, update your graphics driver or disable hardware acceleration.',
  UNKNOWN: 'Restart VibeSync. If the problem persists, check the log file (Settings > About > Open logs).'
}

const CODES: readonly ErrorCode[] = [
  'HELPER_MISSING',
  'HELPER_START_FAILED',
  'HELPER_CRASHED',
  'HELPER_PROTOCOL',
  'DOTNET_MISSING',
  'CAPTURE_INIT_FAILED',
  'DEVICE_NOT_FOUND',
  'DEVICE_DISCONNECTED',
  'NO_AUDIO_DEVICE',
  'BROWSER_CAPTURE_FAILED',
  'BROWSER_CAPTURE_DENIED',
  'UNSUPPORTED_PLATFORM',
  'SETTINGS_IO',
  'RENDERER_CRASH',
  'UNKNOWN'
]

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && (CODES as readonly string[]).includes(v)
}

/** Map an arbitrary code string (e.g. from the helper) onto a known ErrorCode. */
export function toErrorCode(code: unknown): ErrorCode {
  return isErrorCode(code) ? code : 'UNKNOWN'
}

export function makeError(code: ErrorCode, message: string, hint?: string, detail?: string): AppError {
  const err: AppError = { code, message, hint: hint ?? HINTS[code] }
  if (detail) err.detail = detail.length > 4000 ? detail.slice(0, 4000) + '…' : detail
  return err
}

/** Build an AppError from the helper's `{ code, message, detail }` error object. */
export function fromHelperError(e: { code?: unknown; message?: unknown; detail?: unknown } | undefined | null, fallback: ErrorCode): AppError {
  const code = e && isErrorCode(e.code) ? e.code : fallback
  const message =
    e && typeof e.message === 'string' && e.message.trim().length > 0 ? e.message.trim() : defaultMessage(code)
  const detail = e && typeof e.detail === 'string' && e.detail.length > 0 ? e.detail : undefined
  return makeError(code, message, undefined, detail)
}

export function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case 'HELPER_MISSING':
      return 'The VibeSync audio helper (VibeDeckHelper.exe) was not found.'
    case 'HELPER_START_FAILED':
      return 'The VibeSync audio helper could not be started.'
    case 'HELPER_CRASHED':
      return 'The VibeSync audio helper stopped unexpectedly.'
    case 'HELPER_PROTOCOL':
      return 'The VibeSync audio helper sent data VibeSync did not understand.'
    case 'DOTNET_MISSING':
      return 'The .NET Framework required by the audio helper is missing or damaged.'
    case 'CAPTURE_INIT_FAILED':
      return 'System audio capture could not be started.'
    case 'DEVICE_NOT_FOUND':
      return 'The selected playback device is not available.'
    case 'DEVICE_DISCONNECTED':
      return 'The playback device being captured was disconnected.'
    case 'NO_AUDIO_DEVICE':
      return 'No active Windows playback device was found.'
    case 'BROWSER_CAPTURE_FAILED':
      return 'Chromium system audio capture failed.'
    case 'BROWSER_CAPTURE_DENIED':
      return 'System audio capture was not allowed.'
    case 'UNSUPPORTED_PLATFORM':
      return 'This platform is not supported.'
    case 'SETTINGS_IO':
      return 'Settings could not be read or written.'
    case 'RENDERER_CRASH':
      return 'The VibeSync window crashed.'
    default:
      return 'Something went wrong.'
  }
}

/** Windows NTSTATUS codes that mean "the executable or a dependency could not be loaded". */
const NTSTATUS_INVALID_IMAGE_FORMAT = 0xc000007b
const NTSTATUS_DLL_NOT_FOUND = 0xc0000135
const NTSTATUS_DLL_INIT_FAILED = 0xc0000142
const NTSTATUS_ENTRYPOINT_NOT_FOUND = 0xc0000139

/** Normalise a child exit code that Node may report signed or unsigned. */
export function toUnsignedExitCode(code: number | null | undefined): number | null {
  if (code === null || code === undefined || !Number.isFinite(code)) return null
  return code < 0 ? code + 0x100000000 : code
}

/**
 * Heuristic: does this exit code / stderr text look like a .NET Framework problem?
 * (Missing/damaged CLR, wrong bitness, BadImageFormat.)
 */
export function looksLikeDotnetProblem(exitCode: number | null | undefined, stderrText: string): boolean {
  const u = toUnsignedExitCode(exitCode)
  if (
    u === NTSTATUS_INVALID_IMAGE_FORMAT ||
    u === NTSTATUS_DLL_NOT_FOUND ||
    u === NTSTATUS_DLL_INIT_FAILED ||
    u === NTSTATUS_ENTRYPOINT_NOT_FOUND
  ) {
    return true
  }
  const t = stderrText.toLowerCase()
  return (
    t.includes('mscoree') ||
    t.includes('mscorlib') ||
    t.includes('could not be loaded') ||
    t.includes('badimageformat') ||
    t.includes('.net framework') ||
    t.includes('clr20r3') ||
    t.includes('fileloadexception') ||
    t.includes('typeloadexception') ||
    t.includes('could not load file or assembly')
  )
}

export function formatExitCode(code: number | null | undefined): string {
  const u = toUnsignedExitCode(code)
  if (u === null) return 'none'
  return u > 0xffff ? `0x${u.toString(16).toUpperCase()}` : String(u)
}
