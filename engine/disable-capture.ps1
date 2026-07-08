# Disables system-wide capture. Stopping the engine removes the Wintun
# adapter and its routes automatically (the adapter is ephemeral).
# Must run as Administrator - the braid GUI launches it via a UAC prompt.
param(
    [switch]$Hidden
)
$ErrorActionPreference = 'SilentlyContinue'

function Write-Result($ok, $message) {
    $obj = [ordered]@{ ok = $ok; message = "$message"; at = (Get-Date).ToString('o') }
    ($obj | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path $PSScriptRoot 'capture.result.json') -Encoding utf8
}

Stop-Process -Name tun2socks -Force
Start-Sleep -Milliseconds 500

if (Get-Process -Name tun2socks -ErrorAction SilentlyContinue) {
    Write-Result $false 'Could not stop the packet engine.'
    Write-Host 'Could not stop the engine.' -ForegroundColor Red
    if (-not $Hidden) { Read-Host 'Press Enter to close' }
    exit 1
}

Write-Result $true 'System-wide capture disabled.'
Write-Host 'System-wide capture disabled - normal routing restored.' -ForegroundColor Green
if (-not $Hidden) { Start-Sleep -Seconds 2 }
