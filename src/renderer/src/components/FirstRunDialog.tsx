/**
 * First launch welcome dialog. Explains what VibeSync does and asks about the three
 * startup behaviours (all off by default). Continue persists the answers and marks
 * `general.firstRunCompleted`.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { BridgeSetupControl, useBridgeSetup } from '@renderer/settings/BridgeSetup'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { useUiStore } from '@renderer/store/uiStore'
import { IconMicOff, IconOffline, IconSpeaker } from './icons'
import { Logo } from './Logo'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'
import { Toggle } from './ui/Toggle'

const SOURCES = ['Apple Music', 'Spotify', 'YouTube', 'Browsers', 'Games', 'Any audio app']

interface OptionRowProps {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  testId: string
}

function OptionRow({ label, description, checked, onChange, testId }: OptionRowProps): ReactElement {
  return (
    <div className="option-row">
      <div className="option-row__text">
        <span className="option-row__label">{label}</span>
        <span className="option-row__desc">{description}</span>
      </div>
      <Toggle checked={checked} onChange={onChange} aria-label={label} data-testid={testId} />
    </div>
  )
}

export function FirstRunDialog(): ReactElement {
  const setFirstRunOpen = useUiStore((s) => s.setFirstRunOpen)
  const update = useSettingsStore((s) => s.update)
  const [startWithWindows, setStartWithWindows] = useState(false)
  const [startMinimized, setStartMinimized] = useState(false)
  const [keepInTray, setKeepInTray] = useState(false)
  const continueRef = useRef<HTMLButtonElement | null>(null)
  const bridge = useBridgeSetup()

  useEffect(() => {
    continueRef.current?.focus()
  }, [])

  const finish = (): void => {
    update({
      general: {
        startWithWindows,
        startMinimized,
        closeBehavior: keepInTray ? 'tray' : 'quit',
        firstRunCompleted: true
      }
    })
    setFirstRunOpen(false)
  }

  return (
    <div className="modal-root" data-testid="first-run-dialog">
      <div className="modal-backdrop" aria-hidden="true" />
      <div className="modal first-run" role="dialog" aria-modal="true" aria-labelledby="first-run-title" aria-describedby="first-run-lead">
        <div className="first-run__hero">
          <Logo size={64} />
          <div>
            <div className="micro-label first-run__kicker">Welcome</div>
            <h1 id="first-run-title" className="first-run__title">
              Welcome to VibeSync
            </h1>
          </div>
        </div>

        <div className="first-run__body">
          <p id="first-run-lead" className="first-run__lead">
            VibeSync turns <strong>whatever your computer is playing</strong> into a live, music visualizer. It listens to the
            system audio output through WASAPI on Windows or PulseAudio/PipeWire on Linux - so it reacts to any app, with no plug-ins and{' '}
            <strong>no microphone</strong>.
          </p>

          <div className="first-run__sources" aria-label="Works with">
            {SOURCES.map((s) => (
              <Chip key={s}>{s}</Chip>
            ))}
          </div>

          <div className="hint-list" aria-label="Privacy">
            <IconSpeaker size={16} style={{ color: 'var(--accent)' }} />
            <span>Captures the audio your speakers or headphones play - nothing else.</span>
            <IconMicOff size={16} style={{ color: 'var(--accent)' }} />
            <span>The microphone is never opened.</span>
            <IconOffline size={16} style={{ color: 'var(--accent)' }} />
            <span>Audio analysis stays local. Spotify and lyrics use network services.</span>
          </div>

          <div className="first-run__options" role="group" aria-label="Startup options">
            <OptionRow
              label="Start VibeSync with Windows"
              description="Adds a Run entry for your user account. Only takes effect in the installed app."
              checked={startWithWindows}
              onChange={setStartWithWindows}
              testId="first-run-start-with-windows"
            />
            <OptionRow
              label="Start minimized"
              description="Launch quietly to the taskbar or tray instead of opening the window."
              checked={startMinimized}
              onChange={setStartMinimized}
              testId="first-run-start-minimized"
            />
            <OptionRow
              label="Keep running in the tray when closed"
              description="Closing the window hides VibeSync to the notification area instead of quitting."
              checked={keepInTray}
              onChange={setKeepInTray}
              testId="first-run-keep-in-tray"
            />
          </div>

          <div className="first-run__options" role="group" aria-label="Spotify">
            <div className="option-row" data-testid="first-run-bridge">
              <div className="option-row__text">
                <span className="option-row__label">Connect Spotify (optional)</span>
                <span className="option-row__desc">Song details, Up next and synchronized lyrics come from Spotify Desktop. {bridge.description}</span>
              </div>
              <div className="option-row__actions">
                <BridgeSetupControl setup={bridge} />
              </div>
            </div>
          </div>
        </div>

        <div className="first-run__foot">
          <span className="note">You can change all of this later in Settings › General.</span>
          <Button ref={continueRef} variant="primary" size="lg" data-testid="first-run-continue" onClick={finish}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}

export default FirstRunDialog
