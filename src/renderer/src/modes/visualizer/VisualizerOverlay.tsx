/**
 * Minimal DOM overlay for the Visualizer mode: track title/artist/album bottom-left,
 * Spotify Up next bottom-right, FPS top-right when enabled, and the idle hint
 * when no audio is flowing.
 *
 * Text readouts never subscribe per animation frame: hasSignal comes from
 * `audioEngine.subscribeSlow` at 3 Hz, FPS from `frameScheduler.stats` sampled at 2 Hz.
 * The overlay fades out when `uiHidden` is set by the shell (idle auto-hide / H key);
 * the idle hint is deliberately outside that group so it stays readable while waiting.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { audioEngine, frameScheduler } from '@renderer/audio'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { getTrackPositionMs, useTrackStore } from '@renderer/store/trackStore'
import { useSpotifyQueueStore } from '@renderer/store/spotifyQueueStore'
import { useUiStore } from '@renderer/store/uiStore'

export const IDLE_TEXT = 'Waiting for audio… play some music'
const SIGNAL_HZ = 3
const FPS_HZ = 2

function FitSingleLine({ text, className, minFontSize }: { text: string; className: string; minFontSize: number }): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const box = boxRef.current
    const span = textRef.current
    if (!box || !span) return

    let frame = 0
    const fit = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        span.style.fontSize = ''
        span.style.transform = ''
        const available = box.clientWidth
        if (available <= 0 || span.scrollWidth <= available) return

        let size = Number.parseFloat(getComputedStyle(span).fontSize)
        while (span.scrollWidth > available && size > minFontSize) {
          size = Math.max(minFontSize, size - 0.5)
          span.style.fontSize = `${size}px`
        }

        if (span.scrollWidth > available) {
          span.style.transform = `scaleX(${available / span.scrollWidth})`
        }
      })
    }

    const observer = new ResizeObserver(fit)
    observer.observe(box)
    fit()
    void document.fonts?.ready.then(fit)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [text, minFontSize])

  return (
    <div ref={boxRef} className={className} title={text}>
      <span ref={textRef} className="viz-track__fit">{text}</span>
    </div>
  )
}

function useSignal(): boolean {
  const [hasSignal, setHasSignal] = useState(audioEngine.frame.hasSignal)
  useEffect(() => audioEngine.subscribeSlow((frame) => setHasSignal(frame.hasSignal), SIGNAL_HZ), [])
  return hasSignal
}

function useFps(enabled: boolean): number {
  const [fps, setFps] = useState(0)
  useEffect(() => {
    if (!enabled) return
    setFps(Math.round(frameScheduler.stats.fps))
    return audioEngine.subscribeSlow(() => setFps(Math.round(frameScheduler.stats.fps)), FPS_HZ)
  }, [enabled])
  return fps
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

function usePlaybackPosition(enabled: boolean): number {
  const [position, setPosition] = useState(0)
  useEffect(() => {
    const update = (): void => setPosition(getTrackPositionMs(useTrackStore.getState().track))
    update()
    if (!enabled) return
    const timer = setInterval(update, 250)
    return () => clearInterval(timer)
  }, [enabled])
  return position
}

export function VisualizerOverlay(): JSX.Element {
  const uiHidden = useUiStore((s) => s.uiHidden)
  const showFps = useSettingsStore((s) => s.settings.visualizer.showFps)
  const showAlbumArt = useSettingsStore((s) => s.settings.visualizer.showAlbumArt)
  const queue = useSpotifyQueueStore((s) => s.state)
  const showNextTrack = useSettingsStore((s) => s.settings.spotify.showNextTrack)
  const track = useTrackStore((s) => s.track)
  const hasSignal = useSignal()
  const fps = useFps(showFps)
  const hasProgress = track.available && track.durationMs > 0
  const positionMs = usePlaybackPosition(hasProgress)

  const available = track.available
  const title = available && track.title.trim() ? track.title.trim() : 'Unknown Track'
  const artist = available && track.artist.trim() ? track.artist.trim() : 'Unknown Artist'
  const album = available ? track.album.trim() : ''
  const artworkUrl = showAlbumArt && available ? track.artworkUrl : null
  // With no metadata and no audio there is nothing worth labelling; the idle hint speaks instead.
  const showTrack = available || hasSignal

  const artistRef = useRef<HTMLDivElement | null>(null)
  const [artistsWrapped, setArtistsWrapped] = useState(false)
  useLayoutEffect(() => {
    const element = artistRef.current
    if (!element) { setArtistsWrapped(false); return }
    const measure = (): void => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      setArtistsWrapped(element.clientHeight > lineHeight * 1.5)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [artist, showTrack])

  const hasNext = showNextTrack && track.available && queue.currentTrackId === track.trackId && !!queue.nextTrack
  const overlayClass = 'viz-overlay ui-overlay' + (uiHidden ? ' viz-overlay--hidden' : '') + (hasNext ? ' viz-overlay--next' : '')

  return (
    <>
      <div className={overlayClass} data-testid="viz-overlay" aria-hidden={uiHidden}>
        {hasNext && queue.nextTrack ? (
          <div className="viz-next" data-testid="spotify-next-track" aria-label="Up next">
            {queue.nextTrack.artworkUrl ? <img className="viz-next__art" src={queue.nextTrack.artworkUrl} alt="" draggable={false} /> : null}
            <div className="viz-next__text">
              <div className="viz-next__label">Up next</div>
              <FitSingleLine className="viz-next__title" text={queue.nextTrack.title} minFontSize={12} />
              <div className="viz-next__artist" title={queue.nextTrack.artist}>{queue.nextTrack.artist}</div>
            </div>
          </div>
        ) : null}
        {showTrack ? (
          <div className={'viz-track' + (available ? '' : ' viz-track--unknown') + (artistsWrapped ? ' viz-track--wrapped' : '')} data-testid="viz-track">
            {artworkUrl ? <img className="viz-track__art" src={artworkUrl} alt="" draggable={false} /> : null}
            <div className="viz-track__text">
              <FitSingleLine className="viz-track__title" text={title} minFontSize={13} />
              <div ref={artistRef} className="viz-track__artist" title={artist}>{artist}</div>
              {album ? (
                <div className="viz-track__album" title={album}>
                  {album}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {hasProgress ? (
          <div className="viz-progress" data-testid="viz-progress" aria-label={`${formatTime(positionMs)} of ${formatTime(track.durationMs)}`}>
            <div className="viz-progress__times">
              <span>{formatTime(positionMs)}</span>
              <span>{formatTime(track.durationMs)}</span>
            </div>
            <div className="viz-progress__rail">
              <div className="viz-progress__fill" style={{ width: `${Math.min(100, (positionMs / track.durationMs) * 100)}%` }} />
            </div>
          </div>
        ) : null}

        {showFps ? (
          <div className="viz-fps" data-testid="viz-fps">
            {fps} FPS
          </div>
        ) : null}
      </div>

      <div className={'viz-idle' + (hasSignal ? '' : ' viz-idle--visible')} role="status" data-testid="viz-idle">
        {IDLE_TEXT}
      </div>
    </>
  )
}

export default VisualizerOverlay
