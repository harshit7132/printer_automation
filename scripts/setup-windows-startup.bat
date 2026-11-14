@echo off
title Setup Windows Startup - e-Mitra Print Studio
cd /d "%~dp0\.."

set "TARGET=%CD%\start.bat"
set "SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\eMitraPrintStudio.lnk"

echo Creating auto-startup shortcut...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%TARGET%'; $s.WorkingDirectory = '%CD%'; $s.Save()"

if exist "%SHORTCUT%" (
    echo.
    echo ========================================================
    echo SUCCESS: e-Mitra Print Studio will now start automatically
    echo whenever this PC turns on or reboots after a power cut.
    echo Shortcut: %SHORTCUT%
    echo ========================================================
) else (
    echo.
    echo Failed to create startup shortcut. You can manually copy start.bat
    echo into your shell:startup folder.
)
echo.
pause
