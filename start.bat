@echo off
title e-Mitra Print Studio
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time...
  call npm install
)
if not exist .env (
  call npm run setup
)
:loop
call npm start
echo.
echo App stopped. Restarting in 5 seconds... (close this window to quit)
timeout /t 5 >nul
goto loop
