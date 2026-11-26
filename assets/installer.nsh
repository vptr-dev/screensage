; electron-builder forces one-click uninstall into silent mode after confirming.
; Ask in un.onInit, where NSIS can temporarily restore interactive mode.
!macro customUnInit
  Var /GLOBAL screensageDeleteData
  StrCpy $screensageDeleteData "0"
  ${ifNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/S" $R1
    ${if} ${Errors}
      SetSilent normal
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete all ScreenSage data on this PC?$\r$\n$\r$\nThis removes your recents, captures, settings and saved API keys." IDNO screensageKeepData
        StrCpy $screensageDeleteData "1"
      screensageKeepData:
      SetSilent silent
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ${if} $screensageDeleteData == "1"
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
  ${endIf}
!macroend

; Installer upgrades normally preserve missing shortcuts. Restore the Start
; menu entry when upgrading from an installation without one.
!macro customInstall
  ${ifNot} ${FileExists} "$newStartMenuLink"
    Push $keepShortcuts
    StrCpy $keepShortcuts "false"
    !insertmacro addStartMenuLink $keepShortcuts
    Pop $keepShortcuts
    ${if} ${FileExists} "$newStartMenuLink"
      StrCpy $launchLink "$newStartMenuLink"
    ${endIf}
  ${endIf}
!macroend
