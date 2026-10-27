import type { ComponentType } from 'react'
import type { VisualMode } from '@shared/settings'
import { VisualizerMode } from './visualizer/VisualizerMode'

export const MODE_COMPONENTS: Record<VisualMode, ComponentType> = { visualizer: VisualizerMode }
export default MODE_COMPONENTS
