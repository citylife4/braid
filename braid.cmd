@echo off
setlocal
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE_EXE=%LOCALAPPDATA%\Programs\node-v24.18.0-win-x64\node.exe"
"%NODE_EXE%" "%~dp0bin\braid.js" %*
