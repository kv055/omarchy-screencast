// Pure status parsing for the Miracast bar widget. No Qt imports: this file
// loads both as a QML script (Panel.qml) and as a node module (Model.test.js).
//
// Status probe output is one "app=<running|stopped>" line, the output of
// `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`, and the name
// tier lines "alias_name=", "nm_name=", "mdns_name=". Terse mode
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
    connecting: false
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
  if (s.appRunning) return "Picker open"
  if (!s.p2pDevice) return "No P2P device"
  return "Idle"
}

function tooltipText(status) {
  var s = status || emptyStatus()
  if (s.connected) {
    var label = peerLabel(s)
    return label ? "Miracast: " + label : "Miracast connected"
  }
  if (s.connecting) return "Miracast connecting..."
  if (s.appRunning) return "Miracast picker open - not connected"
  if (!s.p2pDevice) return "Miracast unavailable (no P2P device)"
  return "Miracast idle"
}

function linkText(status) {
  var s = status || emptyStatus()
  if (s.connected) return peerLabel(s) || "Connected"
  if (s.connecting) return peerLabel(s) || "Connecting"
  if (s.p2pDevice) return s.p2pDevice + " - " + (s.p2pState || "unknown")
  return "No P2P device"
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
    parseStatus: parseStatus,
    peerLabel: peerLabel,
    statusText: statusText,
    tooltipText: tooltipText,
    linkText: linkText,
    iconFor: iconFor
  }
}
