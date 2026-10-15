; PaperAI — NSIS installer hooks
; Referenced from tauri.conf.json as bundle > windows > nsis > installerHooks.
;
; WHY THIS FILE EXISTS
; --------------------
; `bundle.fileAssociations` looked inert: after a silent `currentUser` install
; nothing at all appeared under HKCU/HKLM\Software\Classes. Reading the
; *generated* installer.nsi showed it is not a config bug but a template bug:
;
;   1. The template DOES call
;        !insertmacro APP_ASSOCIATE "pdf" "PDF Document" ...
;      inside `Section Install`.
;   2. But every macro in FileAssociation.nsh writes through the `SHELL_CONTEXT`
;      variable, and the only `SetShellVarContext` in the whole generated script
;      sits inside the UNINSTALLER, inside a conditional block. During install
;      the shell context is never initialised, so each `WriteRegStr SHELL_CONTEXT`
;      silently fails -> nothing is written.
;   3. When the shell context *is* initialised (verified with an instrumented
;      build: evidence/stage-c/experiment-result.txt), APP_ASSOCIATE sets `.pdf`'s
;      default value to our ProgID — i.e. it CLAIMS the default handler. That is
;      not acceptable here: the user's chosen reader must stay untouched.
;
; So we do not rely on the template's association code at all:
; `bundle.fileAssociations` has been removed from tauri.conf.json and this hook
; performs a candidate-only registration.
;
; `NSIS_HOOK_PREINSTALL` runs at the top of `Section Install`, early enough.

!macro NSIS_HOOK_PREINSTALL
  ; HKCU-level, so no elevation is required.
  SetShellVarContext current

  ; --- register as a candidate, never as the default ---------------------
  ; `Applications\<exe>` is what Explorer lists under "Open with".
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe" "" "${PRODUCTNAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" `"$INSTDIR\${MAINBINARYNAME}.exe" "%1"`

  ; Candidate lists for the extension. We deliberately DO NOT write the
  ; default value of `.pdf` and we DO NOT create our own ProgID, so the user's
  ; existing handler and their "Open with" choice are both preserved.
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "${MAINBINARYNAME}.exe" ""
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithList" "${MAINBINARYNAME}.exe" ""

  ; Ask the shell to re-read associations.
  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetShellVarContext current

  ; Remove only what we added. Never touch `.pdf`'s default value and never
  ; touch another application's ProgID.
  DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "${MAINBINARYNAME}.exe"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithList" "${MAINBINARYNAME}.exe"

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend
