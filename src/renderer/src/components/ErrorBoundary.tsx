/**
 * Catches render errors, reports them to the main process log and shows a friendly screen
 * with Reload / Try again. `resetKey` lets a parent reset the boundary (e.g. when the
 * visual mode changes) without remounting.
 */
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import { errorMessage, getApi } from '@renderer/utils/api'
import { IconError } from './icons'
import { Button } from './ui/Button'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Heading shown on the error screen. */
  title?: string
  /** Where the error happened - included in the report. */
  source?: string
  /** Changing this value clears a caught error. */
  resetKey?: unknown
  /** Offer a "Try again" button that re-renders the children. */
  allowRetry?: boolean
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

export function reportRendererError(message: string, stack?: string, source?: string, componentStack?: string): void {
  const api = getApi()
  if (api) {
    try {
      api.app.reportError({ message, stack, source, componentStack })
      return
    } catch {
      /* fall through */
    }
  }
  console.error('[vibedeck] renderer error', source ?? '', message, stack ?? '')
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(errorMessage(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRendererError(error.message, error.stack, this.props.source ?? 'ErrorBoundary', info.componentStack ?? undefined)
    this.props.onError?.(error, info)
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  private reload = (): void => {
    location.reload()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <ErrorScreen
        title={this.props.title ?? 'Something went wrong'}
        message="VibeSync hit an unexpected error while drawing this screen. The error has been written to the log. Reloading usually fixes it; your audio capture keeps running in the background."
        detail={error.stack || error.message}
        onReload={this.reload}
        onRetry={this.props.allowRetry ? this.retry : undefined}
      />
    )
  }
}

export interface ErrorScreenProps {
  title: string
  message: string
  detail?: string
  onReload?: () => void
  onRetry?: () => void
}

export function ErrorScreen({ title, message, detail, onReload, onRetry }: ErrorScreenProps): ReactElement {
  return (
    <div className="error-screen" role="alert" data-testid="error-screen">
      <div className="error-screen__card">
        <span className="error-screen__icon">
          <IconError />
        </span>
        <h1 className="error-screen__title">{title}</h1>
        <p className="error-screen__text">{message}</p>
        {detail ? <pre className="error-screen__detail">{detail}</pre> : null}
        <div className="error-screen__actions">
          {onRetry ? (
            <Button variant="ghost" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          {onReload ? (
            <Button variant="primary" onClick={onReload}>
              Reload
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default ErrorBoundary
