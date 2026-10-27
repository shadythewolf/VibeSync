import { create } from 'zustand'
import { EMPTY_SPOTIFY_QUEUE, type SpotifyQueueState } from '@shared/types'

export const useSpotifyQueueStore = create<{ state: SpotifyQueueState }>(() => ({ state: EMPTY_SPOTIFY_QUEUE }))
