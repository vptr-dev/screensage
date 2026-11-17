; When ScreenSage is uninstalled (not when it updates itself), offer to remove
; everything it keeps on this PC: recents, captures, settings and saved keys.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete all ScreenSage data on this PC?$\r$\n$\r$\nThis removes your recents, captures, settings and saved API keys." /SD IDNO IDNO screensageKeepData
      RMDir /r "$APPDATA\ScreenSage"
    screensageKeepData:
  ${endIf}
!macroend
