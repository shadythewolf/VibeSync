/**
 * VibeSync PCM capture worklet.
 *
 * Runs on the audio rendering thread. Receives the loopback MediaStream (up-mixed /
 * down-mixed to stereo by the AudioWorkletNode's channelCount = 2), batches 1024 frames
 * of interleaved stereo float32 and posts each batch to the main thread as
 * `{ sampleRate, channels: 2, frames: 1024, buffer }` with the ArrayBuffer transferred
 * (zero-copy). Plain JavaScript: this file is loaded with audioWorklet.addModule().
 */
const BATCH_FRAMES = 1024
const CHANNELS = 2

class VibeSyncPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(BATCH_FRAMES * CHANNELS)
    this.filled = 0
    this.stopped = false
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.stopped = true
    }
  }

  process(inputs) {
    if (this.stopped) return false
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const left = input[0]
    const right = input.length > 1 ? input[1] : input[0]
    const n = left.length
    let buffer = this.buffer
    let filled = this.filled
    for (let i = 0; i < n; i++) {
      const pos = filled * CHANNELS
      buffer[pos] = left[i]
      buffer[pos + 1] = right[i]
      filled++
      if (filled === BATCH_FRAMES) {
        this.port.postMessage({ sampleRate, channels: CHANNELS, frames: BATCH_FRAMES, buffer: buffer.buffer }, [buffer.buffer])
        buffer = new Float32Array(BATCH_FRAMES * CHANNELS)
        filled = 0
      }
    }
    this.buffer = buffer
    this.filled = filled
    return true
  }
}

registerProcessor('vibedeck-pcm-capture', VibeSyncPcmProcessor)
