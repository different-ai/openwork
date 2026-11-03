!macro customUnInstall
  StrCpy $1 ""
  FileOpen $0 "$APPDATA\com.differentai.openwork\windows-brand-shortcut.txt" r
  IfErrors +3
    FileRead $0 $1
    FileClose $0
  ${If} $1 != ""
    Delete "$1"
  ${EndIf}
  Delete "$APPDATA\com.differentai.openwork\windows-brand-shortcut.txt"
!macroend

# An update first runs the old uninstaller, which removes the installed files,
# and only then extracts the new version. If Windows shuts down, restarts or
# signs out in between, the silent installer is killed and the app is gone
# (#6627). Register this installer to run again at the next sign-in; a finished
# install removes the entry. Windows deletes RunOnce entries before running
# them, and the rerun registers itself again, so an interrupted recovery is
# retried too. Per-user installs only: a per-machine rerun would need elevation.
!define OPENWORK_UPDATE_RECOVERY_KEY "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define OPENWORK_UPDATE_RECOVERY_VALUE "${APP_GUID}-update-recovery"

!macro customInit
  ${if} ${isUpdated}
  ${andIf} $installMode == "CurrentUser"
    WriteRegStr HKCU "${OPENWORK_UPDATE_RECOVERY_KEY}" "${OPENWORK_UPDATE_RECOVERY_VALUE}" '"$EXEPATH" --updated /S'
  ${endIf}
!macroend

!macro customInstall
  DeleteRegValue HKCU "${OPENWORK_UPDATE_RECOVERY_KEY}" "${OPENWORK_UPDATE_RECOVERY_VALUE}"
!macroend
