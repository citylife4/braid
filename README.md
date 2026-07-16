# braid

Bond multiple internet connections — Wi-Fi, Ethernet, phone hotspots, USB modems —
into one reliable connection, Speedify-style. Zero-dependency Node.js core, with a
GUI, a virtual network adapter, **system-wide capture for every Windows app**, and
optional **true single-stream aggregation** through a bonding server on a VPS.

```
   every app ──> braid adapter (Wintun) ──> packet engine ──┐
                                                            v
   apps with proxy settings ──────────────> braid :1080 (SOCKS5+UDP / SOCKS4 / HTTP)
                                                            │
                                        ┌───────────────────┴─────────────────┐
                                        ├──> Ethernet ──┐                     │
                                        ├──> Wi-Fi ─────┼──> internet         │
                                        └──> hotspot ───┘                     │
                                        health checks · failover · balancing ─┘
```

## Quick start

The packaged Windows app lives in the system tray. Run the installer or portable
executable, then double-click the tray icon to open the dashboard. Its menu can
start/stop Braid, open the dashboard, quit safely, and toggle **Start with Windows**.

To build both `.exe` variants from source:

```powershell
npm install
npm run build:win
```

Artifacts are written to `dist\`: an NSIS setup executable (recommended for a
stable install path) and a no-install portable executable. Local builds are not
code-signed, so Windows SmartScreen may show an unknown-publisher warning.

The source launchers remain available:

```powershell
.\braid-gui.vbs          # starts braid hidden (no console) + opens the control panel
.\braid-gui.cmd          # same, but from a terminal window
```

or headless:

```powershell
.\braid.cmd --list                          # show detected interfaces
.\braid.cmd                                 # bond everything (proxy :1080, GUI :8181)
.\braid.cmd --links "Ethernet=3,Wi-Fi=1"    # explicit links with weights
```

`braid-gui.vbs` is the "no shell" launcher: braid runs in the background with no
console window, opens the control panel itself, and you stop it with the **Quit**
button in the GUI. New interfaces (a Wi-Fi that connects late, a phone hotspot you
plug in) join the bond automatically within a few seconds. Virtual overlays and VM
adapters (for example Tailscale, WSL and Hyper-V) are ignored during auto-discovery
because they are not independent internet paths.

## Two ways to route apps through the bond

**1. System-wide capture (all apps, zero app config)** — flip the toggle in the GUI.
braid creates a virtual **braid** network adapter and takes over the default route;
every app's TCP and UDP traffic flows through the bond automatically.

- Needs admin: Windows shows a UAC prompt when you toggle it.
- First enable downloads the packet engine (~4 MB): [tun2socks](https://github.com/xjasonlyu/tun2socks)
  v2.6.0 (GPL-3.0) + [Wintun](https://www.wintun.net) 0.14.1 (WireGuard project).
  The download is pinned to exact versions and SHA-256 checked against GitHub's
  published digest before it ever runs. Runtime files are kept in
  `%ProgramData%\braid\engine`, so installed and portable builds share one durable
  engine cache.
- Kill-switch semantics: if braid stops while capture is on, the network drops
  rather than leaking around the bond. Toggle capture off (or run
  `engine\disable-capture.ps1` as admin) to restore normal routing.
- Capture is machine-wide and belongs to one braid instance at a time. If another
  instance already owns it, the GUI identifies that instance instead of silently
  claiming its capture engine.
- Manual equivalents: `engine\enable-capture.ps1` / `engine\disable-capture.ps1`.

**2. Proxy mode (no admin needed)** — point apps at `127.0.0.1:1080`:

- Windows system proxy: `scripts\enable-system-proxy.ps1` / `disable-system-proxy.ps1`
- Chrome/Edge: `--proxy-server="socks5://127.0.0.1:1080"`
- Firefox: SOCKS v5 host `127.0.0.1:1080` + "Proxy DNS when using SOCKS v5"
- curl: `curl --socks5-hostname 127.0.0.1:1080 https://example.com`
- git: `git config --global http.proxy socks5://127.0.0.1:1080`

## The GUI

`braid-gui.vbs` (hidden, no console) or `braid-gui.cmd` opens the control panel as
an app window (Edge app mode). From it you can:

- toggle **system-wide capture** (handles the UAC/elevation flow; the elevated
  script runs hidden and reports success/failure back to the GUI),
- watch per-link throughput, latency, connections and UDP flows live,
- see the **bonded total** across all links, and the **TRUE BONDING** badge with
  live subflow/stream counts when `--server` is set,
- switch strategy on the fly (`balanced` / `least-busy` / `failover`),
- enable/disable individual links with a switch,
- follow the event log (link up/down, hot-plug, failovers, address changes),
- **Quit** braid (needed since the hidden launcher has no console to Ctrl+C).

## Options

```
--port <n>            Proxy port                                  (default 1080)
--bind <addr>         Listen address; 0.0.0.0 shares to your LAN  (default 127.0.0.1)
--dashboard <n>       GUI port, 0 disables                        (default 8181)
--links <spec>        Links to bond: names or IPv4s, =weight
--strategy <name>     balanced | least-busy | failover            (default balanced)
--server <host:port>  Bond through a braid-server for true single-stream aggregation
--secret <token>      Shared secret for --server
--open                Open the control panel in a browser once ready
--check-interval <s>  Seconds between health checks               (default 5)
--check-timeout <s>   Health check timeout                        (default 3)
--verbose             Log each proxied connection
--list                Show detected interfaces and exit
```

## How it works

Windows uses the *strong host model*: a socket bound to an interface's IP sends
through that interface and its gateway. braid binds every outgoing connection to
the interface chosen by the strategy, so different connections ride different
links simultaneously — even while the capture adapter owns the default route
(braid's bound sockets bypass it, which is exactly what makes the design loop-free).

DNS is loop-free too: braid resolves names with resolvers bound to each physical
link (1.1.1.1 / 8.8.8.8), never through the capture adapter.

Reliability comes from three layers:

1. **Active health checks** — each link TCP-dials rotating anycast targets
   (1.1.1.1 / 8.8.8.8 / 9.9.9.9) every few seconds; two consecutive failures
   mark it down.
2. **Passive detection** — dial failures during real traffic count as strikes,
   so dead links are caught faster than the check interval.
3. **Fast failover** — a dying link's connections are killed immediately so apps
   retry at once over the survivors; new connections retry other links before
   the client ever sees an error. UDP sessions (games, calls, DNS) are pinned
   per-flow to one link and re-established on a healthy one if theirs dies.

If DHCP hands an interface a new address after reconnect, braid follows it by
interface name.

## True single-stream bonding (braid-server)

Without a server, aggregation is **per-connection**: many connections spread over
links, but one download still rides one link. To make a *single* connection use
every link at once — the summed-bandwidth trick Speedify markets — braid can bond
through **braid-server**, a tiny relay you run on a VPS with a public IP.

```
  one download ─▶ braid ─┬─▶ Ethernet ─┐
                         ├─▶ Wi-Fi ─────┼─▶  braid-server (VPS)  ─▶ the internet
                         └─▶ hotspot ───┘        reassembles
```

braid splits each connection into 16 KB frames, sprays them across every link's
own TCP subflow, and the server reassembles them in order (per-stream sequence
numbers + cumulative ACKs + retransmit-on-any-surviving-link). If a link dies
mid-download, its in-flight frames are resent over the others and the download
never breaks.

**Run the server** (on a VPS — needs Node 18+ and TCP port 7000 reachable):

```bash
node bin/braid-server.js --port 7000 --secret "your-shared-secret"
```

**Point braid at it:**

```powershell
.\braid.cmd --server your-vps.example.com:7000 --secret "your-shared-secret"
```

The GUI then shows a **TRUE BONDING** badge with live subflow and stream counts.
Only `bin/braid-server.js` and `src/tunnel/` need to be on the server. Set a
`--secret` so it isn't an open relay; put it behind your firewall's allowlist.

## What braid can and cannot do (honesty section)

- **Per-connection by default; per-stream with `--server`.** Out of the box, many
  connections spread across links and their throughput adds up, but one stream
  rides one link. Point `--server` at a braid-server and a *single* stream is
  split across all links and reassembled — real summed bandwidth.
- **Links must reach the internet independently for a real speed gain** (different
  routers/ISPs, or a phone hotspot). Two links into the *same* router share one
  upstream, so you get redundancy/failover but not more bandwidth — bonding can't
  beat a shared bottleneck.
- **IPv4 capture only.** IPv6 traffic bypasses the capture adapter (browsers fall
  back to IPv4 automatically for most sites). IPv6 targets over the proxy are
  refused cleanly.
- **No auth on the proxy.** It binds 127.0.0.1 by default; `--bind 0.0.0.0`
  exposes it to your LAN unauthenticated — only do that on networks you trust.

## Files

```
bin/braid.js               CLI entry point (the client)
bin/braid-server.js        the bonding relay (runs on a VPS)
desktop/main.js            Windows tray host + login-startup controller
braid-gui.vbs              hidden GUI launcher (no console window)
braid-gui.cmd              GUI launcher from a terminal
braid.cmd                  headless launcher
src/links.js               link discovery, hot-plug, health, DNS-per-link, stats
src/dispatch.js            strategies + multi-link dialing with retry
src/proxy.js               SOCKS5 (TCP+UDP) / SOCKS4 / HTTP proxy engine
src/udp.js                 SOCKS5 UDP ASSOCIATE relay (per-flow link pinning)
src/open-browser.js        opens the control panel with no console flash
src/capture.js             elevation launcher + capture status detection
src/dashboard.js           control API + GUI server (127.0.0.1:8181)
src/dashboard.html         the control panel
src/tunnel/frame.js        bonding wire protocol (framing + codecs)
src/tunnel/stream-engine.js  per-stream reliability, reordering, flow control
src/tunnel/client.js       multipath client: subflow per link, stream mux
src/tunnel/server.js       server: reassemble streams, dial targets
engine/enable-capture.ps1  elevated: fetch engine, create adapter, own routes
engine/disable-capture.ps1 elevated: stop engine, restore routing
scripts/                   Windows system-proxy on/off helpers (proxy mode)
scripts/generate-icons.js  reproducible Windows executable/tray icon generator
test/udp-test.js           UDP ASSOCIATE smoke test
test/tunnel-test.js        multipath bonding integrity test (in-process)
```
