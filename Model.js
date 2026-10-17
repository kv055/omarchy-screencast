// Pure status parsing for the Miracast bar widget. No Qt imports: this file
// loads both as a QML script (Panel.qml) and as a node module (Model.test.js).
//
// Status probe output is one "app=<running|stopped>" line, the output of
// `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`, the name tier
// lines, a "known_begin" marker plus one tab-separated
// "known=<mac>\t<epoch>\t<alias>\t<name>" line per history entry, and --
// in scan mode only -- a "sink_begin" marker plus one tab-separated
// "sink=<name>\t<hw>\t<wfd>\t<active>" line per P2P peer. Terse mode
// backslash-escapes literal ':' and '\' inside fields (e.g. the colons in
// "Wi-Fi P2P Peer 9A:03:..."), so fields split on unescaped ':' only.

// Nerd Font icons (JetBrainsMono Nerd Font, verified in the installed file):
// U+F0118 cast outline, U+F0119 cast with filled screen (connected).
// Stored as raw glyphs like the stock plugins; codepoints pinned by test.
var ICON_IDLE = "󰄘"
var ICON_CONNECTED = "󰄙"

function emptyStatus() {
  return {
    appRunning: false,
    p2pDevice: "",
    p2pState: "",
    peer: "",
    aliasName: "",
    nmName: "",
    mdnsName: "",
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
    ["alias_name=", "aliasName"],
    ["nm_name=", "nmName"],
    ["mdns_name=", "mdnsName"]
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
    alias: (f[2] || "").trim(),
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

// Friendly peer label: user alias first, then the P2P device name,
// then the mDNS hostname, then the raw NetworkManager string.
function peerLabel(status) {
  var s = status || emptyStatus()
  return s.aliasName || s.nmName || s.mdnsName || s.peer || ""
}

function statusText(status) {
  var s = status || emptyStatus()
  if (s.connected) return "Connected"
  if (s.connecting) return "Connecting..."
  if (!s.wifiOn) return "Wi-Fi off"
  if (!s.p2pDevice) return "No P2P device"
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
  if (s.appRunning) return "Miracast picker open - not connected"
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
// tests; callers omit it.
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
      label: e.alias || e.name || e.mac,
      badge: isActive ? "Connected" : ((e.epoch || 0) > 0 ? relTime(e.epoch, nowSec) : "Known"),
      active: isActive,
      epoch: e.epoch || 0
    }
  })
}

function sessionMac(status) {
  var m = /^Wi-Fi P2P Peer\s+(.+)$/.exec(String((status && status.peer) || ""))
  return m ? m[1].trim() : ""
}

function isMacAddress(value) {
  return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(String(value || ""))
}

// Single-quote a string for sh: wrap in quotes, escape embedded ones.
function shQuote(value) {
  return "'" + String(value === undefined || value === null ? "" : value).replace(/'/g, "'\\''") + "'"
}

function iconFor(status) {
  var s = status || emptyStatus()
  return s.connected ? ICON_CONNECTED : ICON_IDLE
}

if (typeof module !== "undefined") {
  module.exports = {
    ICON_IDLE: ICON_IDLE,
    ICON_CONNECTED: ICON_CONNECTED,
    emptyStatus: emptyStatus,
    splitTerse: splitTerse,
    parseDeviceRow: parseDeviceRow,
    parseSink: parseSink,
    parseKnown: parseKnown,
    parseStatus: parseStatus,
    peerLabel: peerLabel,
    sinkBadge: sinkBadge,
    relTime: relTime,
    knownRows: knownRows,
    sessionMac: sessionMac,
    isMacAddress: isMacAddress,
    shQuote: shQuote,
    statusText: statusText,
    tooltipText: tooltipText,
    linkText: linkText,
    iconFor: iconFor
  }
}
