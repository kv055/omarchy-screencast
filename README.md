# omarchy-miracast

Omarchy bar widget for Miracast screen sharing (`kili.miracast`), driven by
[FluxCast](https://github.com/IlyaP358/fluxcast).

A cast icon in the top bar mirrors the sender state — idle, connecting,
connected — and a click opens a tiny popup with the link status, available
displays (FluxCast Wi-Fi Direct discovery on open) and previously connected
displays (connection history in
`~/.local/state/kili.miracast/history.tsv`, recorded on connect). Clicking a
row starts a windowless cast straight to that sink — sink selection happens
in the popup, no external window opens. The standalone button appears while
a link is up or the engine is running (**Disconnect**, which stops the
FluxCast session and drops a lingering P2P link).

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
ln -s ~/LocalCodeBases/omarchy-miracast ~/.config/omarchy/plugins/kili.miracast
# add {"id": "kili.miracast"} to the bar layout in ~/.config/omarchy/shell.json
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
omarchy-shell kili.miracast status                    # JSON: connected, connecting, engine, wifi, peer
omarchy-shell kili.miracast connect 9A:03:CF:FC:40:A3 # peer MAC or device-name substring
omarchy-shell kili.miracast disconnect
```

`connect` answers `{"ok":true}` once the session is launched — poll
`status` for the link — or `{"ok":false,"reason":"busy"|"invalid peer"}`.
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
- Only one WFD source can hold RTSP port 7236: quit any other Miracast
  sender before connecting.
