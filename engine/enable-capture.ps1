# Enables system-wide capture: creates the "braid" virtual network adapter
# (Wintun) and routes all IPv4 traffic through braid's proxy port.
#
# Must run as Administrator - the braid GUI launches it via a UAC prompt.
#
# First run downloads the packet engine (pinned versions, checksum-verified):
#   - tun2socks v2.6.0 (xjasonlyu/tun2socks, GPL-3.0) - packets <-> SOCKS
#   - Wintun 0.14.1 (wintun.net, WireGuard project) - the adapter driver
param(
    [string]$DataDir = $PSScriptRoot,
    [int]$ProxyPort = 1080,
    [int]$DashboardPort = 8181,
    [int]$BraidPid = 0,
    [string]$AdapterName = 'braid',
    [switch]$SkipChecksum,
    [switch]$Hidden
)

$ErrorActionPreference = 'Stop'
$engineDir = $DataDir
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null

# Report outcome to the GUI (which polls engine\capture.result.json). When
# launched hidden from the GUI there is no console to read, so we never block
# on a keypress in that mode.
function Write-Result($ok, $message) {
    $obj = [ordered]@{ ok = $ok; message = "$message"; at = (Get-Date).ToString('o') }
    ($obj | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path $engineDir 'capture.result.json') -Encoding utf8
}

# Capture is machine-wide, while several braid copies or custom proxy ports can
# run side by side. Keep one shared ownership record so every dashboard can tell
# whether the active engine belongs to it.
$stateDir = Join-Path $env:ProgramData 'braid'
$stateFile = Join-Path $stateDir 'capture-state.json'

function Read-State {
    try { return Get-Content -Raw -Path $stateFile | ConvertFrom-Json } catch { return $null }
}

function Write-State($processId) {
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $obj = [ordered]@{
        enabled = $true
        enginePid = $processId
        proxyPort = $ProxyPort
        dashboardPort = $DashboardPort
        braidPid = $BraidPid
        adapterName = $AdapterName
        at = (Get-Date).ToString('o')
    }
    ($obj | ConvertTo-Json -Compress) | Set-Content -Path $stateFile -Encoding utf8
}

$TUN2SOCKS_VERSION = 'v2.6.0'
$TUN2SOCKS_ZIP = 'tun2socks-windows-amd64.zip'
$TUN2SOCKS_URL = "https://github.com/xjasonlyu/tun2socks/releases/download/$TUN2SOCKS_VERSION/$TUN2SOCKS_ZIP"
$WINTUN_URL = 'https://www.wintun.net/builds/wintun-0.14.1.zip'

$exe = Join-Path $engineDir 'tun2socks.exe'
$dll = Join-Path $engineDir 'wintun.dll'
$startedEngine = $null
$ownsState = $false

try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script needs Administrator rights. Launch it from the braid GUI or an elevated shell.'
    }

    # ---- first run: fetch and verify the packet engine ----
    if (-not (Test-Path $exe) -or -not (Test-Path $dll)) {
        Write-Host "Downloading packet engine (tun2socks $TUN2SOCKS_VERSION + Wintun 0.14.1)..."
        $tmp = Join-Path $env:TEMP 'braid-engine'
        New-Item -ItemType Directory -Force $tmp | Out-Null

        $zip = Join-Path $tmp $TUN2SOCKS_ZIP
        curl.exe -sSL -o $zip $TUN2SOCKS_URL
        if (-not $SkipChecksum) {
            $api = Invoke-RestMethod "https://api.github.com/repos/xjasonlyu/tun2socks/releases/tags/$TUN2SOCKS_VERSION"
            $expected = ($api.assets | Where-Object name -eq $TUN2SOCKS_ZIP).digest -replace '^sha256:', ''
            $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
            if (-not $expected) { throw 'GitHub did not publish a digest for the engine archive. Re-run with -SkipChecksum if you accept that.' }
            if ($actual -ne $expected) { throw "tun2socks checksum mismatch! expected $expected, got $actual - refusing to install." }
            Write-Host "tun2socks checksum OK ($actual)"
        }
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        Copy-Item (Join-Path $tmp 'tun2socks-windows-amd64.exe') $exe -Force

        $wzip = Join-Path $tmp 'wintun.zip'
        curl.exe -sSL -o $wzip $WINTUN_URL
        Expand-Archive -Path $wzip -DestinationPath $tmp -Force
        Copy-Item (Join-Path $tmp 'wintun\bin\amd64\wintun.dll') $dll -Force
        Write-Host 'Engine ready.'
    }

    # ---- braid must be listening before we hand it the network ----
    $probe = New-Object Net.Sockets.TcpClient
    try { $probe.Connect('127.0.0.1', $ProxyPort) } catch { throw "braid is not listening on 127.0.0.1:$ProxyPort - start braid first." }
    $probe.Close()

    if (Get-Process -Name tun2socks -ErrorAction SilentlyContinue) {
        $state = Read-State
        if ($state -and [int]$state.proxyPort -eq $ProxyPort) {
            Write-Result $true "System-wide capture is already enabled on proxy port $ProxyPort."
            exit 0
        }
        if ($state -and $state.proxyPort) {
            throw "System-wide capture is already managed by another braid instance on proxy port $($state.proxyPort). Disable it there before switching instances."
        }
        throw 'System-wide capture is already active, but its owning braid instance is unknown. Disable the existing capture before enabling this one.'
    }

    # ---- start the engine and wait for the adapter ----
    Write-Host "Starting packet engine on adapter '$AdapterName'..."
    $engine = Start-Process -FilePath $exe `
        -ArgumentList '-device', $AdapterName, '-proxy', "socks5://127.0.0.1:$ProxyPort", '-loglevel', 'warn' `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput (Join-Path $engineDir 'capture.out.log') `
        -RedirectStandardError (Join-Path $engineDir 'capture.err.log')
    $startedEngine = $engine

    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Get-NetAdapter -Name $AdapterName -ErrorAction SilentlyContinue)) {
        if ($engine.HasExited) {
            $detail = Get-Content (Join-Path $engineDir 'capture.err.log') -Tail 3 | Out-String
            throw "the packet engine exited at startup: $detail"
        }
        if ((Get-Date) -gt $deadline) {
            Stop-Process -Id $engine.Id -Force -ErrorAction SilentlyContinue
            throw "the '$AdapterName' adapter did not appear - see $engineDir\capture.err.log"
        }
        Start-Sleep -Milliseconds 400
    }

    # ---- own the default route; DNS rides through the tunnel too ----
    netsh interface ip set address name="$AdapterName" source=static addr=192.168.123.1 mask=255.255.255.0 gateway=192.168.123.1 gwmetric=1 | Out-Null
    netsh interface ip set dnsservers name="$AdapterName" source=static address=8.8.8.8 register=none validate=no | Out-Null
    netsh interface ip add dnsservers name="$AdapterName" address=1.1.1.1 index=2 validate=no | Out-Null
    Set-NetIPInterface -InterfaceAlias $AdapterName -InterfaceMetric 1 -ErrorAction SilentlyContinue

    Write-State $engine.Id
    $ownsState = $true
    Write-Result $true 'System-wide capture enabled.'
    Write-Host ''
    Write-Host 'System-wide capture ENABLED.' -ForegroundColor Green
    Write-Host 'All IPv4 traffic from every app now flows through braid.'
    Write-Host 'Note: if you stop braid while capture is on, the network drops (kill-switch) - run disable-capture.ps1 or use the GUI to restore.'
    if (-not $Hidden) { Start-Sleep -Seconds 3 }
} catch {
    if ($startedEngine -and -not $startedEngine.HasExited) {
        Stop-Process -Id $startedEngine.Id -Force -ErrorAction SilentlyContinue
    }
    if ($ownsState) {
        Remove-Item -Path $stateFile -Force -ErrorAction SilentlyContinue
    }
    Write-Result $false "$_"
    Write-Host ''
    Write-Host "FAILED: $_" -ForegroundColor Red
    if (-not $Hidden) { Read-Host 'Press Enter to close' }
    exit 1
}
