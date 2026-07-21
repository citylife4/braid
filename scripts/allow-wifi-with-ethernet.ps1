# Stop Windows from dropping Wi-Fi while Ethernet is connected.
#
# Windows Connection Manager "minimizes simultaneous connections" by default:
# when a wired connection has internet, it soft-disconnects (or refuses to
# auto-connect) Wi-Fi. That is exactly wrong for a channel bonder, which wants
# every link up at once. This sets the group policy that disables that
# behaviour. Braid's "Wi-Fi assist" toggle works without this, but has to keep
# re-connecting; with the policy set, Windows leaves Wi-Fi alone.
#
#   .\allow-wifi-with-ethernet.ps1          apply the policy (elevates via UAC)
#   .\allow-wifi-with-ethernet.ps1 -Undo    restore the Windows default
param(
  [switch]$Undo,
  [switch]$Elevated,
  [switch]$Hidden  # set by the braid GUI: no console pause at the end
)

$key = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WcmSvc\GroupPolicy'
$name = 'fMinimizeConnections'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  if ($Elevated) {
    Write-Error 'Elevation failed; run this script from an administrator PowerShell.'
    exit 1
  }
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  if ($Undo) { $arguments += '-Undo' }
  if ($Hidden) { $arguments += '-Hidden' }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait
  exit $LASTEXITCODE
}

if ($Undo) {
  if (Test-Path $key) {
    Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
  }
  Write-Host 'Restored the Windows default: Wi-Fi may be soft-disconnected while Ethernet is up.'
} else {
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name $name -PropertyType DWord -Value 0 -Force | Out-Null
  Write-Host 'Done: Windows will keep Wi-Fi connected while Ethernet is up.'
  Write-Host 'Takes effect on the next connection change (no reboot needed).'
}
if (-not $Hidden) { Read-Host 'Press Enter to close' | Out-Null }
