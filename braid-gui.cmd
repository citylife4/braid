@echo off
setlocal
rem braid GUI launcher: starts braid if needed, then opens the control panel
rem as an app window (Edge app mode, falls back to the default browser).

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=%LOCALAPPDATA%\Programs\node-v24.18.0-win-x64\node.exe"

powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',8181); exit 0 } catch { exit 1 } finally { $c.Close() }" >nul 2>nul
if not errorlevel 1 goto open

start "braid" /min "%NODE_EXE%" "%~dp0bin\braid.js"
for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',8181); exit 0 } catch { exit 1 } finally { $c.Close() }" >nul 2>nul
  if not errorlevel 1 goto open
  timeout /t 1 /nobreak >nul
)
echo braid did not start - run: node bin\braid.js
exit /b 1

:open
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://127.0.0.1:8181/
) else (
  start "" "http://127.0.0.1:8181/"
)
