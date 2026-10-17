# omarchy-miracast

Omarchy bar widget for Miracast screen sharing (`kili.miracast`).

A cast icon in the top bar mirrors the sender state — idle, picker open,
connecting, connected — and a click opens a tiny popup with the link status
and one adaptive button: **Connect** (launch/focus the Network Displays
picker) or **Disconnect** (quit the app, drop a lingering P2P link).

Sink selection itself still needs the app window: `gnome-network-displays`
exposes no CLI or D-Bus connect API.

## Files

| File           | Purpose                                                              |
| -------------- | -------------------------------------------------------------------- |
| `manifest.json`| Bar-widget plugin manifest                                           |
| `Panel.qml`    | Bar button + popup; status probe and disconnect actions              |
| `Model.js`     | Pure status parsing (shared by QML and tests)                        |
| `Model.test.js`| Maintained tests (`node --test`)                                    |
| `peers.conf`   | Optional `MAC=Name` aliases for known sinks (case-insensitive)       |

Peer names resolve as: `peers.conf` alias → NetworkManager P2P device name
→ mDNS hostname → raw `Wi-Fi P2P Peer <MAC>` string.

## Install

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

## Notes

- QML edits do **not** hot-reload into the live widget (the file watcher
  fires, but bar instances are not recreated): run `omarchy restart shell`
  after changing `Panel.qml`.
- The status probe matches the app with `pgrep -f 'gnome-network-display[s]'`:
  `pgrep -x` cannot match it (name exceeds the 15-char comm limit), and the
  bracket trick keeps the probe from matching its own command line.
