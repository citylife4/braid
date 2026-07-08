# Routes most Windows apps (browsers included) through braid via the WinINET
# system proxy. Note: Windows treats the "socks=" entry as SOCKS4 in most
# apps — braid speaks SOCKS4 as well as SOCKS5, so that is fine.
param(
    [string]$ProxyHost = '127.0.0.1',
    [int]$Port = 1080
)

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $key -Name ProxyEnable -Value 1
Set-ItemProperty -Path $key -Name ProxyServer -Value "socks=$ProxyHost`:$Port"
Set-ItemProperty -Path $key -Name ProxyOverride -Value 'localhost;127.*;10.*;172.16.*;192.168.*;<local>'

# Tell running apps (WinINET) that proxy settings changed.
$signature = '[DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'
$wininet = Add-Type -MemberDefinition $signature -Name Refresh -Namespace WinInet -PassThru
[void]$wininet::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)  # INTERNET_OPTION_SETTINGS_CHANGED
[void]$wininet::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)  # INTERNET_OPTION_REFRESH

Write-Host "System proxy set to socks=$ProxyHost`:$Port — run scripts\disable-system-proxy.ps1 to undo."
