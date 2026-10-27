/**
 * Session-level media and permission policy.
 *
 * - The display-media handler is what makes Chromium's own WASAPI loopback fallback
 *   work: `getDisplayMedia({ audio: true })` in the renderer resolves to the first screen
 *   plus `audio: 'loopback'` (system audio, Windows only) without any picker UI.
 * - The permission handler denies microphone/camera and everything else except
 *   fullscreen and display-capture (which the fallback relies on). VibeSync never asks
 *   for a microphone.
 */
import { desktopCapturer, type MediaAccessPermissionRequest, type Session } from 'electron'
import { log } from './logger'

export function installDisplayMediaHandler(ses: Session): void {
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
        .then((sources) => {
          const source = sources[0]
          if (!source) {
            log('warn', 'Display media request: no screen sources available')
            callback({})
            return
          }
          log('info', 'Display media request granted (Chromium loopback)', source.name)
          callback({ video: source, audio: 'loopback' })
        })
        .catch((err: unknown) => {
          log('error', 'Display media request failed', err)
          callback({})
        })
    },
    { useSystemPicker: false }
  )
}

export function installPermissionHandlers(ses: Session): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'fullscreen' || permission === 'display-capture') {
      callback(true)
      return
    }
    if (permission === 'media') {
      // getDisplayMedia (system-audio loopback) arrives as a 'media' request WITHOUT
      // mediaTypes; getUserMedia (microphone / camera) always lists 'audio' / 'video'.
      const types = (details as MediaAccessPermissionRequest).mediaTypes ?? []
      const wantsDevice = types.includes('audio') || types.includes('video')
      if (wantsDevice) {
        log('warn', `Denied microphone/camera permission request (${types.join(',')})`)
        callback(false)
        return
      }
      log('info', 'Allowed display-capture media request (Chromium loopback)')
      callback(true)
      return
    }
    log('debug', `Denied permission request: ${permission}`)
    callback(false)
  })

  // Never expose HID / serial / USB devices to the page.
  ses.setDevicePermissionHandler(() => false)
}
