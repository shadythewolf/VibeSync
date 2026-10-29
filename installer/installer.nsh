; VibeSync NSIS customisation (included by electron-builder's assisted installer).
; Keep this minimal: electron-builder handles shortcuts, uninstaller and registry.

!macro customHeader
  !system "echo VibeSync installer build"
!macroend

; Interactive uninstalls (Settings > Apps, Start menu) open the custom VibeSync window
; (installer/setup) instead of NSIS pages. It runs this uninstaller again with /S, so silent
; runs - including electron-updater replacing the old version - never get here.
!macro customUnInit
  ${IfNot} ${Silent}
  ${AndIf} ${FileExists} "$INSTDIR\resources\uninstaller\Uninstall.exe"
    Exec '"$INSTDIR\resources\uninstaller\Uninstall.exe" "--folder=$INSTDIR"'
    Quit
  ${EndIf}
!macroend

!macro customInstall
  ; Register the application in "App Paths" so `VibeSync` can be started from Run / Start search.
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\VibeSync.exe" "" "$INSTDIR\VibeSync.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\VibeSync.exe" "Path" "$INSTDIR"
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\VibeSync.exe"
  ; Remove the "start with Windows" entry if the user enabled it.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VibeSync"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.VibeSync"
!macroend
