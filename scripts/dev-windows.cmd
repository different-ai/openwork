@echo off
setlocal
set "VSDEVCMD=%VSDEVCMD_PATH%"
if not defined VSDEVCMD if exist "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" set "VSDEVCMD=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
if defined VSDEVCMD call "%VSDEVCMD%" -arch=x64 -host_arch=arm64 >nul
call corepack pnpm --filter @openwork/desktop dev:windows
