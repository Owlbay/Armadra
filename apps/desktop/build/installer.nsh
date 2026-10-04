; Armadra's additions to electron-builder's NSIS script (picked up from
; `build/installer.nsh` by default; see electron-builder.yml `nsis`).
;
; The Windows session host runs on Armadra.exe itself
; (`ELECTRON_RUN_AS_NODE=1 Armadra.exe resources\session-host\host.cjs <data>`),
; so a host left over from the last run is an Armadra.exe the installer's
; "is the app running?" step would find and kill by name. Before that step,
; on install, upgrade and uninstall alike, the host is asked to leave if it
; holds no live session (`shutdown-if-idle.cjs`, which waits up to five
; seconds for its process to end). A host that still owns a session stays,
; and the stock step below handles it exactly as before.
;
; Defining `customCheckAppRunning` replaces the stock macro, so the stock body
; is inserted again at the end; the two things it needs that the template
; only declares when this macro is absent are declared here.

!include "getProcessInfo.nsh"
Var pid

!macro armadraReleaseSessionHost
  Push $R8
  Push $R9
  ; Only an install that ships the helper: an older `host.cjs` handed a data
  ; directory would start a host rather than stop one.
  ${if} ${FileExists} "$INSTDIR\resources\session-host\shutdown-if-idle.cjs"
  ${andIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ; The data directory the app resolves (shell-core/paths.ts): the override,
    ; else %LOCALAPPDATA%\Armadra.
    ReadEnvStr $R9 ARMADRA_DATA_DIR
    ${if} $R9 == ""
      ReadEnvStr $R9 LOCALAPPDATA
      StrCpy $R9 "$R9\Armadra"
    ${endIf}
    DetailPrint "Asking the Armadra session host to leave"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
    nsExec::ExecToLog `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\session-host\shutdown-if-idle.cjs" "$R9"`
    Pop $R8
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
  ${endIf}
  Pop $R9
  Pop $R8
!macroend

!macro customCheckAppRunning
  !insertmacro armadraReleaseSessionHost
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
