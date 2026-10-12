@echo off
REM ============================================================
REM  MoneyWala - single-click launcher
REM  Double-click to start the app and open your browser.
REM  To stop: close the "MoneyWala Server" window.
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js was not found on this PC.
  echo Install Node.js LTS from https://nodejs.org
  pause
  exit /b 1
)

echo.
echo  Starting MoneyWala server...
start "MoneyWala Server" node server.js

REM Wait (up to ~15s) until the server actually answers before opening the browser.
node -e "const h=require('http');const t=setInterval(()=>{h.get('http://127.0.0.1:5173/',r=>{r.resume();clearInterval(t);process.exit(0)}).on('error',()=>{})},250);setTimeout(()=>{clearInterval(t);process.exit(0)},15000)"

start "" "http://localhost:5173"

echo.
echo  MoneyWala is open in your browser.
echo  To stop the app, close the "MoneyWala Server" window.
echo.
pause
