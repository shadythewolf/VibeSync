/**
 * Audio capture status + available Windows playback devices (owned by the main process,
 * mirrored here).
 */
import { create } from 'zustand'
import type { AudioDevice, AudioStatus } from '@shared/types'

export const INITIAL_AUDIO_STATUS: AudioStatus = {
  state: 'idle',
  engine: null,
  requestedDeviceId: null,
  deviceId: null,
  deviceName: null,
  sampleRate: 0,
  channels: 0,
  error: null,
  helperAvailable: false,
  chunksReceived: 0,
  updatedAt: 0
}

export interface AudioStatusState {
  status: AudioStatus
  devices: AudioDevice[]
  _setStatus: (status: AudioStatus) => void
  _setDevices: (devices: AudioDevice[]) => void
}

export const useAudioStatusStore = create<AudioStatusState>((set) => ({
  status: INITIAL_AUDIO_STATUS,
  devices: [],
  _setStatus: (status) => set({ status }),
  _setDevices: (devices) => set({ devices })
}))

export const getAudioStatus = (): AudioStatus => useAudioStatusStore.getState().status
