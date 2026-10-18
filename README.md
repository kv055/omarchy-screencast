# omarchy-screencast

Omarchy bar widget for Screencast screen sharing (`kili.screencast`), driven by
[FluxCast](https://github.com/IlyaP358/fluxcast).

A cast icon in the top bar mirrors the sender state — idle, connecting,
connected — and a click opens a tiny popup with the link status, available
displays (FluxCast Wi-Fi Direct discovery on open) and previously connected
displays (connection history in
`~/.local/state/kili.screencast/history.tsv`, recorded on connect). Clicking a
row starts a windowless cast straight to that sink — sink selection happens
in the popup, no external window opens. The standalone button appears while
a link is up, a connect is outstanding, or a disconnect is running
(**Disconnect**, which stops the FluxCast session and drops a lingering P2P
link). It never shows on a Disconnected popup: a widget-started engine that
stays linkless for 90 s is stuck, so the widget reaps it automatically.

A link is not a cast: the sink joins the P2P group first and starts its
video session after (or never, when it missed our discovery). A link
without video reads as **Waiting**, with dots, instead of a false
Connected. Scans are suppressed while a connect is outstanding — a full
scan takes the radio off-channel and collapses the handshake. If the
attempt fails — the engine dies before any link, wedges linkless, or the
link comes up but video never starts within a minute — the widget tears
it down, waits 10 s, and retries the connect once: the sink's own logs
show an accepted invitation sometimes forms no group while an identical
retry succeeds, and a missed video trigger never recovers by waiting.
Disconnect during the pause cancels the retry. Every engine run appends
its output to `~/.local/state/kili.screencast/fluxcast.log` (trimmed to
200 lines, one `=== kili.screencast run <epoch> ===` marker per run),
the only record of the handshake once the widget moves on.

When something goes wrong, the popup says what, in the theme's urgent
color under the link line (also in the tooltip and the IPC `status`):
the widget reads the attempt's own engine log, logged firewall drops,
and what it observed itself, and names the cause, with a fix where
there is one. A firewall dropping the sink's RTSP dial shows up while
the link waits, and the link is kept: the sink redials every ~20 s, so
fixing the firewall lets video start without a new click. Local setup
problems (no FluxCast, port 7236 taken, no monitor, no Wi-Fi Direct
device) refuse the click up front and skip the automatic retry. The
error stays until the next click or until video flows.

| Code            | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| `firewall`      | Kernel log shows drops of the sink's dial to TCP 7236          |
| `no-video`      | Link up a minute, sink never opened its video session          |
| `not-found`     | FluxCast's scans never saw the peer                            |
| `link-failed`   | The Wi-Fi Direct link never completed                          |
| `rtsp-failed`   | The sink broke off the RTSP setup (FluxCast's reason attached) |
| `sink-ended`    | The sink tore down a session that had played                   |
| `lost`          | A playing link dropped without a teardown from either side     |
| `media-failed`  | Screen capture or encoding failed to start                     |
| `no-monitor`    | No capturable monitor                                          |
| `port-busy`     | Another sender holds TCP 7236                                  |
| `not-ready`     | FluxCast's doctor checks fail (`fluxcast --doctor`)            |
| `no-p2p`        | NetworkManager exposes no Wi-Fi P2P device                     |
| `not-installed` | `fluxcast` is not on `PATH`                                    |
| `crashed`       | FluxCast died with an uncaught exception (named)               |
| `engine-error`  | Any other FluxCast `ERROR:` line, shown verbatim               |
| `engine-exit`   | FluxCast exited before a link with nothing in its log          |

## Files

| File           | Purpose                                                              |
| -------------- | -------------------------------------------------------------------- |
| `manifest.json`| Bar-widget plugin manifest                                           |
| `Panel.qml`    | Bar button + popup; connect-by-click and disconnect actions          |
| `probe.sh`     | Status/discovery probe (`fast` tick, `scan` on open)                 |
| `Model.js`     | Pure status parsing + engine commands (shared by QML and tests)      |
| `Model.test.js`| Maintained tests (`node --test`)                                     |

Peer names resolve as: NetworkManager P2P device name → mDNS hostname →
raw NetworkManager connection string. Matching is by MAC; receivers
whose group-interface MAC differs from their discovery MAC show the raw
link name instead of badges.

## Migrating from 1.x

2.0 swaps the engine from GNOME Network Displays to FluxCast and drops
the `peers.conf` MAC→name aliases: sinks show their device names
everywhere. Delete the file if you customized it; connection history
carries over untouched.

## Install

Engine first (FluxCast from the AUR, capture + monitor detection from the
repos, and the WFD RTSP port if the firewall is active):

```bash
omarchy pkg aur add fluxcast-git
omarchy pkg add wf-recorder xorg-xrandr
sudo ufw allow 7236/tcp  # only if ufw is active
```

This repo is the source of truth; the live plugin dir is a symlink to it:

```bash
ln -s ~/LocalCodeBases/omarchy-screencast ~/.config/omarchy/plugins/kili.screencast
# add {"id": "kili.screencast"} to the bar layout in ~/.config/omarchy/shell.json
omarchy restart shell
```

## Test

```bash
node --test Model.test.js
```

## Automation (OMCP)

The widget answers scripted control over the shell bus — the same code
paths as popup clicks — which the OMCP tools wrap:

```bash
omarchy-shell kili.screencast status                    # JSON: connected, connecting, video, engine, wifi, peer, error, errorCode
omarchy-shell kili.screencast connect 9A:03:CF:FC:40:A3 # peer MAC or exact device name
omarchy-shell kili.screencast disconnect
```

`connect` answers `{"ok":true}` once the session is launched — poll
`status` for the link, and its `errorCode`/`error` (the popup's error
line, `""` when none) for a failure — or
`{"ok":false,"reason":"busy"|"invalid peer"|"unknown peer"|"ambiguous peer"}`.
A local setup problem refuses with its error code as the reason plus an
`error` message, e.g. `{"ok":false,"reason":"port-busy","error":"..."}`.
`disconnect` answers `{"ok":true}`, or `{"ok":false,"reason":"idle"}`.

## Notes

- QML edits do **not** hot-reload into the live widget (the file watcher
  fires, but bar instances are not recreated): run `omarchy restart shell`
  after changing `Panel.qml`.
- The status probe matches the engine with `pgrep -f 'protocol wf[d]'`:
  the bracket trick keeps the probe from matching its own command line,
  and the pattern only matches a WFD session, never a `--wfd-scan` run.
- Disconnect signals the engine with SIGINT first so FluxCast runs its own
  cleanup (media stop, link deactivation), then drops any lingering P2P
  link via `nmcli`.
- Renaming from `kili.miracast` moves state to
  `~/.local/state/kili.screencast/`; move `history.tsv` across to keep
  Previous Connections.
- Only one WFD source can hold RTSP port 7236: quit any other Screencast
  sender before connecting.
- Firewall diagnosis reads the kernel journal (`journalctl -k`), which
  needs membership in `wheel`, `adm` or `systemd-journal`; without it a
  blocked dial reads as `no-video`. Only logged drops count: ufw logs
  them by default, firewalld only with `LogDenied`.
