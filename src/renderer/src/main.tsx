/**
 * Renderer entry point. Installs global error reporting, initialises the stores / IPC
 * wiring / frame scheduler, then mounts <App/>.
 */
import './styles/global.css'
import './styles/ui.css'
import './styles/shell.css'
import './styles/settings.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { reportRendererError } from '@renderer/components/ErrorBoundary'
import { useUiStore } from '@renderer/store/uiStore'
import { initializeApp } from '@renderer/store/wiring'
import { errorMessage, getApi } from '@renderer/utils/api'

const TOAST_DEDUPE_MS = 5000
const recentErrors = new Map<string, number>()

/** Rate-limit identical error toasts so a hot loop cannot flood the UI. */
function shouldToast(message: string): boolean {
  const now = Date.now()
  const last = recentErrors.get(message) ?? 0
  if (now - last < TOAST_DEDUPE_MS) return false
  if (recentErrors.size > 64) recentErrors.clear()
  recentErrors.set(message, now)
  return true
}

function notify(title: string, message: string): void {
  if (!shouldToast(message)) return
  useUiStore.getState().pushToast({ kind: 'error', title, message, timeout: 6000 })
}

function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (ev: ErrorEvent) => {
    const err: unknown = ev.error
    const message = err instanceof Error ? err.message : ev.message || 'Unknown error'
    const stack = err instanceof Error ? err.stack : undefined
    const source = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : 'window.onerror'
    reportRendererError(message, stack, source)
    notify('Unexpected error', message)
  })
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const reason: unknown = ev.reason
    const message = errorMessage(reason)
    const stack = reason instanceof Error ? reason.stack : undefined
    reportRendererError(message, stack, 'unhandledrejection')
    notify('Unhandled promise rejection', message)
  })
}

/** Plain-DOM fallback when the preload bridge is missing (opened outside Electron / broken install). */
function renderMissingApi(container: HTMLElement): void {
  container.replaceChildren()
  const root = document.createElement('div')
  root.className = 'boot-fallback'
  root.setAttribute('data-testid', 'boot-fallback')
  const card = document.createElement('div')
  card.className = 'boot-fallback__card'
  const title = document.createElement('div')
  title.className = 'boot-fallback__title'
  title.textContent = 'VibeSync cannot start'
  const text = document.createElement('p')
  text.className = 'boot-fallback__text'
  text.textContent =
    'The VibeSync bridge (window.vibedeck) is not available, so the app cannot reach the audio capture or your settings. ' +
    'This happens when the page is opened outside of the VibeSync desktop app or the installation is damaged. Please reinstall VibeSync.'
  const button = document.createElement('button')
  button.className = 'btn btn--primary'
  button.type = 'button'
  button.textContent = 'Reload'
  button.addEventListener('click', () => location.reload())
  card.append(title, text, button)
  root.append(card)
  container.append(root)
}

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')
  if (!container) {
    throw new Error('Renderer bootstrap failed: #root element is missing from index.html')
  }
  if (!getApi()) {
    renderMissingApi(container)
    return
  }
  installGlobalErrorHandlers()
  try {
    await initializeApp()
  } catch (err) {
    reportRendererError(errorMessage(err), err instanceof Error ? err.stack : undefined, 'initializeApp')
    useUiStore.getState().pushToast({
      kind: 'error',
      title: 'Start-up problem',
      message: `${errorMessage(err)}. Some features may be unavailable until you reload.`,
      timeout: 0
    })
  }
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void bootstrap()
