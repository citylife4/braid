# Disables system-wide capture. Stopping the engine removes the Wintun
# adapter and its routes automatically (the adapter is ephemeral).
# Must run as Administrator - the braid GUI launches it via a UAC prompt.
$ErrorActionPreference = 'SilentlyContinue'

Stop-Process -Name tun2socks -Force
Start-Sleep -Milliseconds 500

if (Get-Process -Name tun2socks -ErrorAction SilentlyContinue) {
    Write-Host 'Could not stop the engine.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

Write-Host 'System-wide capture disabled - normal routing restored.' -ForegroundColor Green
Start-Sleep -Seconds 2
