!macro customInstall
  DetailPrint "Adding Windows Firewall exception for OpenWork..."
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="OpenWork Local Server" dir=in action=allow program="$INSTDIR\$appExeName" enable=yes profile=any'

  DetailPrint "Verifying protocol handler registration..."
  WriteRegStr SHCTX "Software\Classes\openwork" "" "URL:OpenWork Protocol"
  WriteRegStr SHCTX "Software\Classes\openwork" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\openwork\shell\open\command" "" '"$INSTDIR\$appExeName" "%1"'
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall exception for OpenWork..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="OpenWork Local Server" program="$INSTDIR\$appExeName"'

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
