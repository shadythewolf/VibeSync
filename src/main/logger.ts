/**
 * File logger for the main process.
 *
 * - Writes to <userData>/logs/vibedeck.log, rotating at 2 MB (vibedeck.log + vibedeck.1.log).
 * - Lines logged before `initLogger()` are buffered and flushed once the path is known.
 * - Writes are batched and asynchronous; `flushLogSync()` drains synchronously on quit.
 * - Mirrors to the console in development (or when VIBEDECK_LOG_CONSOLE=1).
 */
import { app } from 'electron'
import { appendFile, appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { LogLevel } from '../shared/types'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const LOG_FILE = 'vibedeck.log'
const ROTATED_FILE = 'vibedeck.1.log'
const MAX_PENDING_BYTES = 512 * 1024
const MAX_DETAIL_CHARS = 8000
const FLUSH_DELAY_MS = 25

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const LEVEL_TAG: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' }

let logDir = ''
let logPath = ''
let initialized = false
let mirrorToConsole = false
let minLevel: LogLevel = 'debug'
let currentSize = 0
let pending = ''
let flushTimer: ReturnType<typeof setTimeout> | null = null
let writing = false
let preInitBuffer: string[] = []

function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null || detail === '') return ''
  let text: string
  if (typeof detail === 'string') text = detail
  else if (detail instanceof Error) text = detail.stack || `${detail.name}: ${detail.message}`
  else {
    try {
      text = JSON.stringify(detail)
    } catch {
      text = String(detail)
    }
  }
  if (text.length > MAX_DETAIL_CHARS) text = text.slice(0, MAX_DETAIL_CHARS) + '…[truncated]'
  return text
}

function formatLine(level: LogLevel, message: string, detail?: unknown): string {
  const ts = new Date().toISOString()
  const d = formatDetail(detail)
  const base = `${ts} [${LEVEL_TAG[level]}] ${message}`
  if (!d) return base + '\n'
  if (d.includes('\n')) return base + '\n' + d.replace(/^/gm, '    ') + '\n'
  return `${base} | ${d}\n`
}

function rotateIfNeeded(extraBytes: number): void {
  if (currentSize + extraBytes <= MAX_FILE_BYTES) return
  try {
    const rotated = join(logDir, ROTATED_FILE)
    if (existsSync(rotated)) unlinkSync(rotated)
    if (existsSync(logPath)) renameSync(logPath, rotated)
  } catch (err) {
    // If rotation fails we keep appending to the current file rather than losing lines.
    if (mirrorToConsole) console.warn('[logger] rotation failed', err)
  }
  currentSize = 0
}

function scheduleFlush(): void {
  if (flushTimer !== null || writing || !initialized) return
  flushTimer = setTimeout(flushAsync, FLUSH_DELAY_MS)
}

function flushAsync(): void {
  flushTimer = null
  if (writing || pending.length === 0 || !initialized) return
  const chunk = pending
  pending = ''
  const bytes = Buffer.byteLength(chunk, 'utf8')
  rotateIfNeeded(bytes)
  currentSize += bytes
  writing = true
  appendFile(logPath, chunk, { encoding: 'utf8' }, (err) => {
    writing = false
    if (err && mirrorToConsole) console.warn('[logger] write failed', err)
    if (pending.length > 0) scheduleFlush()
  })
}

/** Synchronously drain buffered lines (call on quit). */
export function flushLogSync(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!initialized || pending.length === 0) return
  const chunk = pending
  pending = ''
  try {
    const bytes = Buffer.byteLength(chunk, 'utf8')
    rotateIfNeeded(bytes)
    currentSize += bytes
    appendFileSync(logPath, chunk, { encoding: 'utf8' })
  } catch (err) {
    if (mirrorToConsole) console.warn('[logger] sync write failed', err)
  }
}

function enqueue(line: string): void {
  if (!initialized) {
    preInitBuffer.push(line)
    if (preInitBuffer.length > 500) preInitBuffer.shift()
    return
  }
  pending += line
  if (pending.length > MAX_PENDING_BYTES) {
    // Never let a runaway logger eat memory; drop the oldest half.
    pending = pending.slice(pending.length >> 1)
  }
  scheduleFlush()
}

function mirror(level: LogLevel, line: string): void {
  if (!mirrorToConsole) return
  const text = line.replace(/\n$/, '')
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

/**
 * Initialise the file logger. Must run after `app.setPath('userData')` overrides and
 * before anything else logs from the ready handler (earlier lines are buffered).
 */
export function initLogger(options?: { level?: LogLevel; console?: boolean }): void {
  if (initialized) return
  logDir = join(app.getPath('userData'), 'logs')
  logPath = join(logDir, LOG_FILE)
  mirrorToConsole = options?.console ?? (!app.isPackaged || process.env.VIBEDECK_LOG_CONSOLE === '1')
  if (options?.level) minLevel = options.level
  try {
    mkdirSync(logDir, { recursive: true })
    currentSize = existsSync(logPath) ? statSync(logPath).size : 0
  } catch (err) {
    currentSize = 0
    console.warn('[logger] could not prepare log directory', err)
  }
  initialized = true
  const buffered = preInitBuffer
  preInitBuffer = []
  for (const line of buffered) enqueue(line)
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

export function log(level: LogLevel, message: string, detail?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  const line = formatLine(level, message, detail)
  mirror(level, line)
  enqueue(line)
}

export const logger = {
  debug: (message: string, detail?: unknown): void => log('debug', message, detail),
  info: (message: string, detail?: unknown): void => log('info', message, detail),
  warn: (message: string, detail?: unknown): void => log('warn', message, detail),
  error: (message: string, detail?: unknown): void => log('error', message, detail)
}

export function getLogPath(): string {
  return logPath || join(app.getPath('userData'), 'logs', LOG_FILE)
}

export function getLogDir(): string {
  return logDir || join(app.getPath('userData'), 'logs')
}

/** Human readable text for an unknown thrown value. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Short one-line message for an unknown thrown value (safe to show in the UI). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}
