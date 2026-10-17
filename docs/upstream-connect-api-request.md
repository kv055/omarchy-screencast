# Upstream request: programmatic sink connection for GNOME Network Displays

File at: https://gitlab.gnome.org/GNOME/gnome-network-displays/-/issues
(Not filed yet — draft only. Do not file without asking.)

---

**Title:** Programmatic sink connection: CLI flag and/or D-Bus API

**Body:**

## Problem

There is currently no way to list available sinks or connect to one
without driving the full GUI:

- `gnome-network-displays --help` exposes only generic GApplication flags.
- The session-bus API is only `org.gtk.Application` (`Activate`) plus the
  window object — no sink objects, no connect/disconnect methods.
  (Verified on 0.99.0 by walking the object tree of the running app.)

This blocks desktop widgets, scripts, keyboard-driven workflows, and
auto-connect to a known display (e.g. "always cast to the living-room TV
when it appears").

## What already works

Sink *discovery* needs no help: NetworkManager exposes Wi-Fi P2P peers
(`StartFind`/`StopFind`, `Peers` with `Name`/`HwAddress`/`WfdIEs`), which
is sufficient to build a sink list externally. The missing piece is purely
the connect-and-stream trigger, which only the app's internal WFD engine
can perform.

## Proposed API (any of these would do)

1. `gnome-network-displays --connect <name|mac>` — connect to a known sink
   (fuzzy name match or exact P2P MAC), exit code reflects success.
2. D-Bus methods on `org.gnome.NetworkDisplays`, e.g. `ListSinks() →
   a{sv}` and `ConnectSink(s identifier)`, plus a `SinkAdded`/`SinkRemoved`
   signal for live widgets.
3. Bonus: `--list-sinks` with machine-readable (JSON) output.

Happy to test early builds of any of these against real Miracast hardware.

Environment: gnome-network-displays 0.99.0 (Arch), Wayland/Hyprland,
Miracast projector + Fire TV Stick as sinks.
