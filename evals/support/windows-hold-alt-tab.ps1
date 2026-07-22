$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class OpenWorkKeyboard {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
"@

$keyUp = 0x0002
$alt = 0x12
$tab = 0x09

try {
    [OpenWorkKeyboard]::keybd_event($alt, 0, 0, [UIntPtr]::Zero)
    [OpenWorkKeyboard]::keybd_event($tab, 0, 0, [UIntPtr]::Zero)
    [OpenWorkKeyboard]::keybd_event($tab, 0, $keyUp, [UIntPtr]::Zero)
    Start-Sleep -Seconds 8
}
finally {
    [OpenWorkKeyboard]::keybd_event($alt, 0, $keyUp, [UIntPtr]::Zero)
}
