@echo off
setlocal

set "TARGET_ARCH=%~1"
set "VSDEVCMD=%VSDEVCMD_PATH%"
set "HOST_ARCH=x64"

if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "HOST_ARCH=arm64"
if /I "%TARGET_ARCH%"=="x64" (
  set "VS_ARCH=x64"
) else (
  set "VS_ARCH=%HOST_ARCH%"
)

if not defined VSDEVCMD if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find Common7\Tools\VsDevCmd.bat`) do set "VSDEVCMD=%%i"
if not defined VSDEVCMD if exist "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" set "VSDEVCMD=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"

if not defined VSDEVCMD (
  echo [openwork] Could not find VsDevCmd.bat. Install Visual Studio Build Tools with Desktop development with C++.
  exit /b 1
)

call "%VSDEVCMD%" -arch=%VS_ARCH% -host_arch=%HOST_ARCH% >nul
if errorlevel 1 exit /b %errorlevel%

if /I "%TARGET_ARCH%"=="x64" (
  call corepack pnpm --filter @openwork/desktop dev:windows:x64
) else (
  call corepack pnpm --filter @openwork/desktop dev:windows
)
