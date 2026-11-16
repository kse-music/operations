!macro ServerDeckRefreshIcon PATH
  ; SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSH: refresh an existing application item.
  IfFileExists "${PATH}" 0 +2
    System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x00001005, w "${PATH}", p 0) v'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Invalidate the Shell's icon cache before updating the application's existing items.
  ; SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH; no cache files are deleted.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x00001000, p 0, p 0) v'

  !insertmacro ServerDeckRefreshIcon "$INSTDIR\${MAINBINARYNAME}.exe"

  !if "${STARTMENUFOLDER}" != ""
    !insertmacro ServerDeckRefreshIcon "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    !insertmacro ServerDeckRefreshIcon "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif

  !insertmacro ServerDeckRefreshIcon "$DESKTOP\${PRODUCTNAME}.lnk"
!macroend
