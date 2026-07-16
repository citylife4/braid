# Disables system-wide capture. Stopping the engine removes the Wintun
# adapter and its routes automatically (the adapter is ephemeral).
# Must run as Administrator - the braid GUI launches it via a UAC prompt.
param(
    [string]$DataDir = $PSScriptRoot,
    [switch]$Hidden
)
$ErrorActionPreference = 'SilentlyContinue'
$engineDir = $DataDir
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null

function Write-Result($ok, $message) {
    $obj = [ordered]@{ ok = $ok; message = "$message"; at = (Get-Date).ToString('o') }
    ($obj | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path $engineDir 'capture.result.json') -Encoding utf8
}

$stateDir = Join-Path $env:ProgramData 'braid'
$stateFile = Join-Path $stateDir 'capture-state.json'
$state = $null
try { $state = Get-Content -Raw -Path $stateFile | ConvertFrom-Json } catch {}

if ($state -and $state.enginePid) {
    $ownedProcess = Get-Process -Id ([int]$state.enginePid) -ErrorAction SilentlyContinue
    if ($ownedProcess -and $ownedProcess.ProcessName -eq 'tun2socks') {
        Stop-Process -Id $ownedProcess.Id -Force
    } else {
        Stop-Process -Name tun2socks -Force
    }
} else {
    # Backward compatibility for capture sessions started before ownership
    # tracking was added.
    Stop-Process -Name tun2socks -Force
}
Start-Sleep -Milliseconds 500

if (Get-Process -Name tun2socks -ErrorAction SilentlyContinue) {
    Write-Result $false 'Could not stop the packet engine.'
    Write-Host 'Could not stop the engine.' -ForegroundColor Red
    if (-not $Hidden) { Read-Host 'Press Enter to close' }
    exit 1
}

Remove-Item -Path $stateFile -Force
Write-Result $true 'System-wide capture disabled.'
Write-Host 'System-wide capture disabled - normal routing restored.' -ForegroundColor Green
if (-not $Hidden) { Start-Sleep -Seconds 2 }
