# braid

Bond multiple internet connections — Wi-Fi, Ethernet, phone hotspots, USB modems —
into one reliable connection, Speedify-style. Zero-dependency Node.js core, with a
GUI, a virtual network adapter, and **system-wide capture for every Windows app**.

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

```powershell
.\braid-gui.cmd          # starts braid + opens the control panel window
```

or headless:

```powershell
.\braid.cmd --list                          # show detected interfaces
.\braid.cmd                                 # bond everything (proxy :1080, GUI :8181)
.\braid.cmd --links "Ethernet=3,Wi-Fi=1"    # explicit links with weights
```

## Two ways to route apps through the bond

**1. System-wide capture (all apps, zero app config)** — flip the toggle in the GUI.
braid creates a virtual **braid** network adapter and takes over the default route;
every app's TCP and UDP traffic flows through the bond automatically.

- Needs admin: Windows shows a UAC prompt when you toggle it.
- First enable downloads the packet engine (~4 MB): [tun2socks](https://github.com/xjasonlyu/tun2socks)
  v2.6.0 (GPL-3.0) + [Wintun](https://www.wintun.net) 0.14.1 (WireGuard project).
  The download is pinned to exact versions and SHA-256 checked against GitHub's
  published digest before it ever runs.
- Kill-switch semantics: if braid stops while capture is on, the network drops
  rather than leaking around the bond. Toggle capture off (or run
  `engine\disable-capture.ps1` as admin) to restore normal routing.
- Manual equivalents: `engine\enable-capture.ps1` / `engine\disable-capture.ps1`.

**2. Proxy mode (no admin needed)** — point apps at `127.0.0.1:1080`:

- Windows system proxy: `scripts\enable-system-proxy.ps1` / `disable-system-proxy.ps1`
- Chrome/Edge: `--proxy-server="socks5://127.0.0.1:1080"`
- Firefox: SOCKS v5 host `127.0.0.1:1080` + "Proxy DNS when using SOCKS v5"
- curl: `curl --socks5-hostname 127.0.0.1:1080 https://example.com`
- git: `git config --global http.proxy socks5://127.0.0.1:1080`

## The GUI

`braid-gui.cmd` opens the control panel as an app window (Edge app mode). From it you can:

- toggle **system-wide capture** (handles the UAC/elevation flow),
- watch per-link throughput, latency, connections and UDP flows live,
- see the **bonded total** across all links,
- switch strategy on the fly (`balanced` / `least-busy` / `failover`),
- enable/disable individual links with a switch,
- follow the event log (link up/down, failovers, address changes).

## Options

```
--port <n>            Proxy port                                  (default 1080)
--bind <addr>         Listen address; 0.0.0.0 shares to your LAN  (default 127.0.0.1)
--dashboard <n>       GUI port, 0 disables                        (default 8181)
--links <spec>        Links to bond: names or IPv4s, =weight
--strategy <name>     balanced | least-busy | failover            (default balanced)
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

## What braid can and cannot do (honesty section)

- **Aggregation is per-connection/per-flow.** Many parallel connections (browsers,
  downloaders, torrents, most apps) spread across all links and their throughput
  adds up — but a *single* TCP stream still rides one link. Splitting one stream
  across links like Speedify does requires a bonding **server on the internet**
  that reassembles packets. braid is server-less by design; a braid-server relay
  would be the natural v3.
- **Links must reach the internet independently** (different routers/ISPs or a
  phone hotspot). Two links into the same router = failover only, shared upstream.
- **IPv4 capture only.** IPv6 traffic bypasses the capture adapter (browsers fall
  back to IPv4 automatically for most sites). IPv6 targets over the proxy are
  refused cleanly.
- **No auth on the proxy.** It binds 127.0.0.1 by default; `--bind 0.0.0.0`
  exposes it to your LAN unauthenticated — only do that on networks you trust.

## Files

```
bin/braid.js               CLI entry point
braid-gui.cmd              GUI launcher (starts braid + opens the app window)
braid.cmd                  headless launcher
src/links.js               link discovery, health, DNS-per-link, stats
src/dispatch.js            strategies + multi-link dialing with retry
src/proxy.js               SOCKS5 (TCP+UDP) / SOCKS4 / HTTP proxy engine
src/udp.js                 SOCKS5 UDP ASSOCIATE relay (per-flow link pinning)
src/capture.js             elevation launcher + capture status detection
src/dashboard.js           control API + GUI server (127.0.0.1:8181)
src/dashboard.html         the control panel
engine/enable-capture.ps1  elevated: fetch engine, create adapter, own routes
engine/disable-capture.ps1 elevated: stop engine, restore routing
scripts/                   Windows system-proxy on/off helpers (proxy mode)
test/udp-test.js           UDP ASSOCIATE smoke test
```
