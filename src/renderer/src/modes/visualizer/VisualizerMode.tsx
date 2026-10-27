/**
 * VISUALIZER. A full-bleed canvas driven by VisualizerRenderer plus a minimal
 * DOM overlay (track, next song, FPS, idle hint). The mode owns no audio state: the engine and
 * the frame scheduler are singletons, ModeCanvas registers the draw callback.
 */
import { Lyrics, useLyricsStore } from '@renderer/components/Lyrics'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { ModeCanvas } from '@renderer/visualizer/ModeCanvas'
import { VisualizerOverlay } from './VisualizerOverlay'
import { VisualizerRenderer } from './VisualizerRenderer'
import './visualizer.css'

/** Stable factory so ModeCanvas creates exactly one renderer per mount. */
const createRenderer = (): VisualizerRenderer => new VisualizerRenderer()

export function VisualizerMode(): JSX.Element {
  const lyrics = useSettingsStore(s => s.settings.lyrics)
  const hasLyrics = useLyricsStore(s => s.state.lines.length > 0)
  return (
    <div className={`viz${lyrics.enabled && hasLyrics ? " viz--lyrics" : ""}`} style={{ "--lyrics-height": `${Math.round(lyrics.fontSize * (lyrics.showContext ? 4.1 : 1.6) + lyrics.lineGap * (lyrics.showContext ? 2 : 0) + 20)}px` } as React.CSSProperties} data-testid="mode-visualizer">
      <ModeCanvas create={createRenderer} className="viz__canvas" />
      <VisualizerOverlay />
      <Lyrics />
    </div>
  )
}

export default VisualizerMode
