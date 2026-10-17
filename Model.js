// Pure status parsing for the Miracast bar widget. No Qt imports: this file
// loads both as a QML script (Panel.qml) and as a node module (Model.test.js).
//
// Status probe output is one "app=<running|stopped>" line (a FluxCast WFD
// session process), the output of
// `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`, the name tier
// lines plus a "peer_mac=<mac>" line (the P2P peer, resolved by the probe
// from the group interface neighbors -- FluxCast names its NM link
// "FluxCast WFD" instead of "Wi-Fi P2P Peer <MAC>"), a "known_begin"
// marker plus one tab-separated "known=<mac>\t<epoch>\t\t<name>" line
// per history entry, and -- in scan mode only -- a "sink_begin" marker
// plus one tab-separated "sink=<name>\t<hw>\t<wfd>\t<active>" line per
// WFD peer found by `fluxcast --wfd-scan`. Terse mode backslash-escapes
// literal ':' and '\' inside fields (e.g. the colons in
// "Wi-Fi P2P Peer 9A:03:..."), so fields split on unescaped ':' only.

// Nerd Font icons (JetBrainsMono Nerd Font, verified in the installed file):
// U+F0118 cast outline, U+F0119 cast with filled screen (connected).
// Stored as raw glyphs like the stock plugins; codepoints pinned by test.
var ICON_IDLE = "󰄘"
var ICON_CONNECTED = "󰄙"

// pgrep/pkill pattern matching a FluxCast WFD session
// (`fluxcast --protocol wfd ...`, never a `--wfd-scan` run). The bracket
// trick keeps the matcher from matching its own command line: the regex
// needs a literal "wfd", but the command line only ever holds "wf[d]".
var ENGINE_PATTERN = "protocol wf[d]"

function emptyStatus() {
  return {
    appRunning: false,
    p2pDevice: "",
    p2pState: "",
    peer: "",
    nmName: "",
    mdnsName: "",
    peerMac: "",
    connected: false,
    connecting: false,
    wifiOn: true,
    sinks: [],
    hasSinks: false,
    knownRaw: []
  }
}

function splitTerse(line) {
  var fields = []
  var cur = ""
  var esc = false
  var text = String(line === undefined || line === null ? "" : line)
  for (var i = 0; i < text.length; i++) {
    var c = text[i]
    if (esc) {
      cur += c
      esc = false
    } else if (c === "\\") {
      esc = true
    } else if (c === ":") {
      fields.push(cur)
      cur = ""
    } else {
      cur += c
    }
  }
  fields.push(cur)
  return fields
}

function parseDeviceRow(line) {
  var f = splitTerse(line)
  return {
    device: f[0] || "",
    type: f[1] || "",
    state: f[2] || "",
    connection: f[3] || ""
  }
}

function peerNameLine(status, line) {
  var tiers = [
    ["nm_name=", "nmName"],
    ["mdns_name=", "mdnsName"],
    ["peer_mac=", "peerMac"]
  ]
  for (var i = 0; i < tiers.length; i++) {
    if (line.indexOf(tiers[i][0]) === 0) {
      status[tiers[i][1]] = line.slice(tiers[i][0].length).trim()
      return true
    }
  }
  return false
}

// Tab-separated by the probe so names may contain colons, spaces, and
// non-ASCII unambiguously. Never throws; missing fields get safe defaults.
function parseSink(body) {
  var f = String(body === undefined || body === null ? "" : body).split("\t")
  var name = (f[0] || "").trim()
  return {
    name: name === "" ? "(unknown)" : name,
    hw: (f[1] || "").trim(),
    wfd: f[2] === "1",
    active: f[3] === "1"
  }
}

// History entry from the probe. Returns null for rows without a MAC, which
// can neither merge nor display.
function parseKnown(body) {
  var f = String(body === undefined || body === null ? "" : body).split("\t")
  var mac = (f[0] || "").trim()
  if (mac === "") return null
  var epoch = parseInt(f[1], 10)
  return {
    mac: mac,
    epoch: isFinite(epoch) && epoch > 0 ? epoch : 0,
    name: (f[3] || "").trim()
  }
}

function parseStatus(text) {
  var status = emptyStatus()
  var lines = String(text === undefined || text === null ? "" : text).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    if (line === "app=running") {
      status.appRunning = true
      continue
    }
    if (line === "app=stopped") continue
    if (line === "wifi=disabled") {
      status.wifiOn = false
      continue
    }
    if (line === "wifi=enabled") continue
    if (line === "sink_begin") {
      status.hasSinks = true
      continue
    }
    if (line.indexOf("sink=") === 0) {
      status.sinks.push(parseSink(line.slice("sink=".length)))
      continue
    }
    if (line === "known_begin") continue
    if (line.indexOf("known=") === 0) {
      var known = parseKnown(line.slice("known=".length))
      if (known) status.knownRaw.push(known)
      continue
    }
    if (peerNameLine(status, line)) continue
    var row = parseDeviceRow(line)
    if (row.type === "wifi-p2p" && status.p2pDevice === "") {
      status.p2pDevice = row.device
      status.p2pState = row.state
      status.peer = row.connection
    }
  }
  status.connected = status.p2pState.indexOf("connected") === 0
  status.connecting = !status.connected && status.p2pState.indexOf("connecting") === 0
  return status
}

// Friendly peer label: the P2P device name, then the mDNS hostname,
// then the raw NetworkManager string.
function peerLabel(status) {
  var s = status || emptyStatus()
  return s.nmName || s.mdnsName || s.peer || ""
}

// Hero corner text: nothing while a connect or disconnect is in flight
// (even if the link is momentarily still up), Connected on a live link,
// Disconnected otherwise. Steady causes (Wi-Fi off, no P2P device) read
// as Disconnected here; the link line and tooltip keep the details.
function heroStatus(status, busy) {
  var s = status || emptyStatus()
  if (busy) return ""
  if (s.connected) return "Connected"
  return "Disconnected"
}

function tooltipText(status) {
  var s = status || emptyStatus()
  if (s.connected) {
    var label = peerLabel(s)
    return label ? "Miracast: " + label : "Miracast connected"
  }
  if (s.connecting) return "Miracast connecting..."
  if (!s.wifiOn) return "Miracast needs Wi-Fi - please turn it on"
  if (s.appRunning) return "Miracast engine running - not connected"
  if (!s.p2pDevice) return "Miracast unavailable (no P2P device)"
  return "Miracast idle"
}

function linkText(status) {
  var s = status || emptyStatus()
  if (s.connected) return peerLabel(s) || "Connected"
  if (s.connecting) return peerLabel(s) || "Connecting"
  if (!s.wifiOn) return "Please turn on Wi-Fi to use casting"
  return ""
}

// Cycling dots for activity lines ("Scanning", "Connecting to ..."),
// driven by a QML timer frame counter: ".", "..", "...", repeat.
function dots(frame) {
  var f = Number(frame || 0)
  return "...".substring(0, 1 + (((f % 3) + 3) % 3))
}

// Re-derive Connected badges on a cached scan: fast ticks carry no sink
// section, so without this a row stays "Connected" forever after its
// link drops. Returns a new array; never mutates. sessionMac is "" when
// no link is up, which clears every badge.
function refreshSinkActives(sinks, sessionMac) {
  var active = String(sessionMac || "").toUpperCase()
  return (sinks || []).map(function(s) {
    var sink = s || {}
    var hw = String(sink.hw || "").toUpperCase()
    return {
      name: sink.name || "(unknown)",
      hw: sink.hw || "",
      wfd: sink.wfd === true,
      active: active !== "" && hw !== "" && hw === active
    }
  })
}

// Right-hand badge for a discovered sink row.
function sinkBadge(sink) {
  var s = sink || {}
  if (s.active) return "Connected"
  if (s.wfd) return "Display"
  return "Device"
}

function relTime(epochSec, nowSec) {
  var now = nowSec === undefined ? Math.floor(Date.now() / 1000) : nowSec
  var diff = now - Number(epochSec || 0)
  if (!(diff > 0)) return "just now"
  if (diff < 60) return "just now"
  if (diff < 3600) return Math.floor(diff / 60) + "m ago"
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago"
  return Math.floor(diff / 86400) + "d ago"
}

// Known-display rows: history entries not currently nearby, deduped by MAC
// (newest wins), newest first. The session peer keeps a Connected badge so
// an active-but-unscanned link still shows up. nowSec is injectable for
// tests; callers omit it. Rows carry the MAC plus the raw history name so a
// click can connect directly without a scan.
function knownRows(nearby, knownRaw, sessionMac, nowSec) {
  var near = {}
  var i
  var list = nearby || []
  for (i = 0; i < list.length; i++) {
    var hw = list[i] ? String(list[i].hw || "").toUpperCase() : ""
    if (hw !== "") near[hw] = true
  }
  var active = String(sessionMac || "").toUpperCase()
  var byMac = {}
  var raw = knownRaw || []
  for (i = 0; i < raw.length; i++) {
    var entry = raw[i] || {}
    var mac = String(entry.mac || "").toUpperCase()
    if (mac === "" || near[mac]) continue
    if (!byMac[mac] || (entry.epoch || 0) > (byMac[mac].epoch || 0)) byMac[mac] = entry
  }
  var rows = []
  for (var key in byMac) rows.push(byMac[key])
  rows.sort(function(a, b) { return (b.epoch || 0) - (a.epoch || 0) })
  return rows.map(function(e) {
    var isActive = active !== "" && String(e.mac || "").toUpperCase() === active
    return {
      label: e.name || e.mac,
      badge: isActive ? "Connected" : ((e.epoch || 0) > 0 ? relTime(e.epoch, nowSec) : "Known"),
      active: isActive,
      epoch: e.epoch || 0,
      mac: e.mac || "",
      name: e.name || ""
    }
  })
}

// The P2P peer MAC: the probe's peer_mac line when present (FluxCast names
// its link "FluxCast WFD", which carries no MAC), else the legacy
// "Wi-Fi P2P Peer <MAC>" connection string.
function sessionMac(status) {
  var s = status || {}
  if (s.peerMac) return String(s.peerMac).trim()
  var m = /^Wi-Fi P2P Peer\s+(.+)$/.exec(String(s.peer || ""))
  return m ? m[1].trim() : ""
}

function isMacAddress(value) {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(String(value || ""))
}

// Peer selector for scripted connects (the OMCP IPC verb): a MAC address
// (exact) or a device-name substring (FluxCast matches it). Pure scan
// indexes are refused: they shift between scans and would cast blind.
function isPeerSelector(value) {
  var s = String(value === undefined || value === null ? "" : value).trim()
  if (s === "" || s.length > 64) return false
  if (/^\d+$/.test(s)) return false
  if (/^-/.test(s)) return false
  if (isMacAddress(s)) return true
  return !/[\x00-\x1f\x7f]/.test(s)
}

// Resolve a scripted peer selector against cached discovery. MACs pass
// through untouched (looking up a display name when cached); names must
// match exactly (case-insensitive) and unambiguously, because FluxCast
// would otherwise cast to the first substring match. Returns {mac, name}
// or {error}. Never throws.
function resolvePeer(sinks, selector) {
  var list = sinks || []
  var s = String(selector === undefined || selector === null ? "" : selector).trim()
  var i, row
  if (isMacAddress(s)) {
    var up = s.toUpperCase()
    for (i = 0; i < list.length; i++) {
      row = list[i] || {}
      if (String(row.hw || "").toUpperCase() === up && row.name) {
        return { mac: s, name: row.name }
      }
    }
    return { mac: s, name: "" }
  }
  var lower = s.toLowerCase()
  var hits = []
  for (i = 0; i < list.length; i++) {
    row = list[i] || {}
    if (String(row.name || "").toLowerCase() === lower && isMacAddress(row.hw)) {
      hits.push(row)
    }
  }
  if (hits.length === 1) return { mac: hits[0].hw, name: hits[0].name }
  if (hits.length === 0) return { error: "unknown peer" }
  return { error: "ambiguous peer" }
}

// Single-quote a string for sh: wrap in quotes, escape embedded ones.
function shQuote(value) {
  return "'" + String(value === undefined || value === null ? "" : value).replace(/'/g, "'\\''") + "'"
}

// argv for a windowless FluxCast WFD session to the given peer MAC or name.
// The monitor resolves at connect time -- current DISPLAY first, then
// every XWayland display in /tmp -- since FluxCast would otherwise
// prompt on stdin. Only connected outputs qualify, primary first.
// stdin is closed so a missing monitor fails fast instead of blocking
// on a prompt nobody can answer.
function connectCommand(peer) {
  var findMon = "xrandr --query 2>/dev/null | awk '$2==\"connected\"{if(!f)f=$1} $2==\"connected\"&&$3==\"primary\"{p=$1} END{print (p!=\"\"?p:f)}'"
  var script = "mon=$(" + findMon + "); "
    + "if [ -z \"$mon\" ]; then "
    + "for l in /tmp/.X[0-9]*-lock; do "
    + "[ -e \"$l\" ] || continue; "
    + "d=${l#/tmp/.X}; d=:${d%-lock}; "
    + "mon=$(DISPLAY=$d " + findMon + "); "
    + "[ -n \"$mon\" ] && break; "
    + "done; fi; "
    + "exec fluxcast --protocol wfd --wfd-timeout 4 --wfd-peer " + shQuote(peer)
    + " ${mon:+--monitor \"$mon\"} </dev/null"
  return ["sh", "-c", script]
}

// argv tearing down a FluxCast WFD session: SIGINT first so the engine runs
// its own cleanup (media stop, NM deactivation, GO-intent restore last),
// polled every 150 ms so a fast exit returns immediately, SIGTERM past
// ~5 s for wedged stragglers, then an nmcli disconnect for a lingering
// P2P link. Always exits true.
function disconnectCommand() {
  var script = "pkill -INT -f '" + ENGINE_PATTERN + "' 2>/dev/null; "
    + "i=0; while [ $i -lt 33 ]; do "
    + "pgrep -f '" + ENGINE_PATTERN + "' >/dev/null 2>&1 || break; sleep 0.15; i=$((i+1)); done; "
    + "pkill -f '" + ENGINE_PATTERN + "' 2>/dev/null; "
    + "for dev in $(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2==\"wifi-p2p\"{print $1}'); do "
    + "nmcli device disconnect \"$dev\" >/dev/null 2>&1; done; true"
  return ["sh", "-c", script]
}

function iconFor(status) {
  var s = status || emptyStatus()
  return s.connected ? ICON_CONNECTED : ICON_IDLE
}

if (typeof module !== "undefined") {
  module.exports = {
    ICON_IDLE: ICON_IDLE,
    ICON_CONNECTED: ICON_CONNECTED,
    ENGINE_PATTERN: ENGINE_PATTERN,
    emptyStatus: emptyStatus,
    splitTerse: splitTerse,
    parseDeviceRow: parseDeviceRow,
    parseSink: parseSink,
    parseKnown: parseKnown,
    parseStatus: parseStatus,
    peerLabel: peerLabel,
    refreshSinkActives: refreshSinkActives,
    sinkBadge: sinkBadge,
    relTime: relTime,
    knownRows: knownRows,
    sessionMac: sessionMac,
    isMacAddress: isMacAddress,
    isPeerSelector: isPeerSelector,
    resolvePeer: resolvePeer,
    shQuote: shQuote,
    connectCommand: connectCommand,
    disconnectCommand: disconnectCommand,
    heroStatus: heroStatus,
    tooltipText: tooltipText,
    linkText: linkText,
    dots: dots,
    iconFor: iconFor
  }
}
