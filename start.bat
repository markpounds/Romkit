@echo off
setlocal
chcp 65001 >nul 2>nul
title ROMKit
cd /d "%~dp0"

if not exist "%~dp0data" mkdir "%~dp0data"

rem ---- locate node.exe ----
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto HAVE_NODE

for %%p in ("%ProgramFiles%\nodejs\node.exe" "%ProgramW6432%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%APPDATA%\nvm\node.exe" "%USERPROFILE%\scoop\apps\nodejs\current\node.exe") do if not defined NODE_EXE if exist "%%~p" set "NODE_EXE=%%~p"
if defined NODE_EXE goto HAVE_NODE

if exist "%USERPROFILE%\.workbuddy\binaries\node\versions" (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE_EXE if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
)
if defined NODE_EXE goto HAVE_NODE
goto NO_NODE

:HAVE_NODE
echo [%date% %time%] node=%NODE_EXE%>>"%~dp0data\start.log"
echo.
echo   ROMKit  local service
echo   node: %NODE_EXE%
echo.
echo   Keep this window OPEN while using ROMKit.
echo   Close it or press Ctrl+C to quit.
echo.
"%NODE_EXE%" server.js --open
set "CODE=%ERRORLEVEL%"
echo.
echo   ROMKit stopped. exit code = %CODE%
echo [%date% %time%] stopped code=%CODE%>>"%~dp0data\start.log"
pause
exit /b %CODE%

:NO_NODE
echo [%date% %time%] node not found>>"%~dp0data\start.log"
echo.
echo   [ROMKit] Node.js was not found on this computer.
echo.
echo   Please install Node.js 18 or newer, then run this file again:
echo     https://nodejs.org/
echo.
pause
exit /b 1
