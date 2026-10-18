// Pure status parsing for the Screencast bar widget. No Qt imports: this file
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
//
// Failure evidence rides along: "engine_bin=<yes|no>" (FluxCast
// installed), "rtsp_port=busy" (a foreign listener holds the RTSP port),
// "fw_block=<n>" (logged firewall drops of the sink's RTSP dial, only
// while an engine runs), and the latest engine run from fluxcast.log as
// one "log_run=<epoch>" line plus up to 60 "log=<line>" lines.

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

// A widget-started engine that stays linkless this long is stuck: a healthy
// link comes up in well under a minute. The widget reaps it instead of
// leaving a Disconnect button on a Disconnected popup.
var LINKLESS_REAP_MS = 90000

// Settle pause before the one automatic retry: relaunching into the same
// instant the previous handshake died just repeats it -- the sink's own
// logs show its successful retries tens of seconds apart.
var RECOVERY_DELAY_MS = 10000

// Link up but no video for this long means the sink's display app missed
// its trigger; it never starts on its own (observed for minutes). The
// widget tears the session down and retries once instead of waiting
// forever. Healthy video starts within seconds of the link.
var WAITING_VIDEO_MS = 60000

function shouldRecoverWaiting(waitingMs) {
  return Number(waitingMs) >= WAITING_VIDEO_MS
}

// The engine's RTSP port: the sink dials it once the P2P link is up.
var RTSP_PORT = 7236

var LOG_PATH = "~/.local/state/kili.screencast/fluxcast.log"

function shouldReapLinkless(linklessMs) {
  return Number(linklessMs) >= LINKLESS_REAP_MS
}

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
    video: false,
    wifiOn: true,
    sinks: [],
    hasSinks: false,
    knownRaw: [],
    // False until a probe answered: an empty status must not read as
    // "no P2P device" and refuse the first click.
    probed: false,
    engineInstalled: true,
    portBusy: false,
    fwBlocked: false,
    logRun: 0,
    logLines: []
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
    // Engine log lines first: their payload is free text that could
    // look like any other probe line.
    if (line.indexOf("log=") === 0) {
      status.logLines.push(line.slice("log=".length))
      continue
    }
    if (line.indexOf("log_run=") === 0) {
      var run = parseInt(line.slice("log_run=".length), 10)
      status.logRun = isFinite(run) && run > 0 ? run : 0
      continue
    }
    if (line === "app=running") {
      status.appRunning = true
      status.probed = true
      continue
    }
    if (line === "app=stopped") {
      status.probed = true
      continue
    }
    if (line === "engine_bin=no") {
      status.engineInstalled = false
      continue
    }
    if (line === "engine_bin=yes") continue
    if (line === "rtsp_port=busy") {
      status.portBusy = true
      continue
    }
    if (line.indexOf("fw_block=") === 0) {
      status.fwBlocked = parseInt(line.slice("fw_block=".length), 10) > 0
      continue
    }
    if (line === "wifi=disabled") {
      status.wifiOn = false
      continue
    }
    if (line === "wifi=enabled") continue
    if (line === "video=yes") {
      status.video = true
      continue
    }
    if (line === "video=no") continue
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
// (even if the link is momentarily still up). A link without video is
// "Waiting", not "Connected": the sink joined the P2P group but never
// started its video session (it missed our discovery), which used to
// read as a working cast. Steady causes (Wi-Fi off, no P2P device)
// read as Disconnected here; the link line and tooltip keep the details.
function heroStatus(status, busy) {
  var s = status || emptyStatus()
  if (busy) return ""
  if (s.connected) return s.video ? "Connected" : "Waiting"
  return "Disconnected"
}

// errorText is the popup's error line (see errorMessage); a live link
// without video shows it too, since that is when it explains the wait.
function tooltipText(status, errorText) {
  var s = status || emptyStatus()
  var err = String(errorText || "")
  if (s.connected) {
    if (!s.video) return err ? "Screencast: " + err : "Screencast waiting for the display to start video"
    var label = peerLabel(s)
    return label ? "Screencast: " + label : "Screencast connected"
  }
  if (s.connecting) return "Screencast connecting..."
  if (!s.wifiOn) return "Screencast needs Wi-Fi - please turn it on"
  if (err) return "Screencast: " + err
  if (s.appRunning) return "Screencast engine running - not connected"
  if (!s.p2pDevice) return "Screencast unavailable (no P2P device)"
  return "Screencast idle"
}

function linkText(status) {
  var s = status || emptyStatus()
  if (s.connected) return peerLabel(s) || "Connected"
  if (s.connecting) return peerLabel(s) || "Connecting"
  if (!s.wifiOn) return "Please turn on Wi-Fi to use casting"
  return ""
}

// Engine log evidence as [pattern, code], root causes before symptoms: a
// dropped link also fails ffmpeg ("Network is unreachable"), and media
// failures surface inside RTSP ERROR lines, so both outrank the RTSP rule.
var ENGINE_FAILURES = [
  [/Address already in use/, "port-busy"],
  [/ERROR: Monitor '.*' not found/, "no-monitor"],
  [/ERROR: Miracast\/WFD is not ready/, "not-ready"],
  [/ERROR: NetworkManager (did not expose a Wi-Fi P2P device|P2P device disappeared)/, "no-p2p"],
  [/ERROR: (No Wi-Fi Direct peers found|No peer matched selector)/, "not-found"],
  [/ERROR: (Timed out waiting for NetworkManager|NetworkManager (de)?activated the Wi-Fi Direct connection)/, "link-failed"],
  [/Network is unreachable|Cannot assign requested address/, "lost"],
  [/exited immediately|Error opening output file/, "media-failed"],
  [/WFD RTSP\] (ERROR: |Socket closed: |TV disconnected from )|<- request: TEARDOWN/, "rtsp-failed"]
]

// Why an engine run failed, from its log lines (the probe's log= lines).
// Returns {code, detail} or null when the run shows no failure. detail
// carries FluxCast's own words where no canned cause fits. Never throws.
function engineFailure(lines) {
  var list = lines || []
  var text = list.join("\n")
  for (var i = 0; i < ENGINE_FAILURES.length; i++) {
    if (!ENGINE_FAILURES[i][0].test(text)) continue
    var code = ENGINE_FAILURES[i][1]
    if (code !== "rtsp-failed") return { code: code, detail: "" }
    // Video already played: the sink ended a session, not its setup.
    if (/PLAY accepted/.test(text)) return { code: "sink-ended", detail: "" }
    var rtsp = /WFD RTSP\] ERROR: (.+)/.exec(text)
    return { code: code, detail: rtsp ? rtsp[1] : "" }
  }
  var err = /\[FluxCast[^\]]*\] ERROR: (.+)/.exec(text)
  if (err) return { code: "engine-error", detail: err[1] }
  // Uncaught exception: the traceback's last line names it. A SIGINT
  // before the session loop surfaces as KeyboardInterrupt -- that is our
  // own teardown, not a crash.
  if (/^Traceback \(most recent call last\):/m.test(text)) {
    for (var j = list.length - 1; j >= 0; j--) {
      var line = String(list[j]).trim()
      if (/^KeyboardInterrupt/.test(line)) return null
      if (/^[A-Za-z_][\w.]*(Error|Exception|Exit)\b/.test(line)) return { code: "crashed", detail: line }
    }
    return { code: "crashed", detail: "" }
  }
  return null
}

// The failure to report for an attempt: this attempt's engine log first,
// then a logged firewall drop of the sink's RTSP dial, then what the
// widget itself observed (fallback). sinceEpoch is when the attempt
// launched; older log runs belong to an earlier attempt, and 0 ignores
// the log (a foreign engine's output never reaches it). The "lost"
// fallback is a drop after video, where only a sink teardown refines it.
// Returns {code, detail}.
function diagnose(status, sinceEpoch, fallback) {
  var s = status || emptyStatus()
  var since = Number(sinceEpoch || 0)
  var lines = since > 0 && s.logRun >= since ? (s.logLines || []) : []
  if (fallback === "lost") {
    var ended = /<- request: TEARDOWN|TV disconnected from/.test(lines.join("\n"))
    return { code: ended ? "sink-ended" : "lost", detail: "" }
  }
  var found = engineFailure(lines)
  if (found) return found
  if (s.fwBlocked) return { code: "firewall", detail: "" }
  return { code: fallback || "engine-exit", detail: "" }
}

// FluxCast's own words for display: one line, no control characters,
// capped so a traceback cannot flood the popup.
function cleanDetail(detail) {
  var s = String(detail === undefined || detail === null ? "" : detail)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return s.length > 160 ? s.slice(0, 159) + "…" : s
}

// User-facing text for a failure code: what went wrong, then what to do
// when there is something to do. peer names the display ("" reads "the
// display"). "" for no code.
function errorMessage(code, peer, detail) {
  var name = String(peer === undefined || peer === null ? "" : peer).trim()
  var Who = name || "The display"
  var who = name || "the display"
  var why = cleanDetail(detail)
  switch (String(code || "")) {
  case "":
    return ""
  case "firewall":
    return "Firewall is blocking " + who + " on TCP " + RTSP_PORT
      + ". Run: sudo ufw allow " + RTSP_PORT + "/tcp && sudo ufw reload"
  case "no-video":
    return Who + " joined but never started video. If a firewall is active, allow TCP " + RTSP_PORT + "."
  case "not-found":
    return Who + " was not found. Is it on and in screen-mirroring mode?"
  case "link-failed":
    return Who + " did not complete the Wi-Fi Direct link. Try again."
  case "rtsp-failed":
    return Who + " broke off the video session setup" + (why ? " (" + why.replace(/\.$/, "") + ")." : ".")
  case "sink-ended":
    return Who + " ended the session."
  case "lost":
    return "Lost the connection to " + who + "."
  case "media-failed":
    return "Screen capture failed to start. See " + LOG_PATH
  case "no-monitor":
    return "No monitor found to capture."
  case "port-busy":
    return "TCP port " + RTSP_PORT + " is in use. Quit the other screencast sender."
  case "not-ready":
    return "Casting is not set up on this machine. Run: fluxcast --doctor"
  case "no-p2p":
    return "No Wi-Fi Direct device available. Is Wi-Fi on?"
  case "not-installed":
    return "FluxCast is not installed. Run: omarchy pkg aur add fluxcast-git"
  case "crashed":
    return why ? "FluxCast crashed: " + why : "FluxCast crashed. See " + LOG_PATH
  case "engine-error":
    return why ? "FluxCast: " + why : "FluxCast failed. See " + LOG_PATH
  case "engine-exit":
    return "FluxCast stopped before connecting. See " + LOG_PATH
  default:
    return "Screencast failed. See " + LOG_PATH
  }
}

// Problems that refuse a click before any engine runs: a missing engine,
// a foreign sender holding the RTSP port, no Wi-Fi Direct device. Wi-Fi
// off is left to linkText, which already names it. "" when none.
function steadyError(status) {
  var s = status || emptyStatus()
  if (!s.probed) return ""
  if (!s.engineInstalled) return "not-installed"
  if (!s.wifiOn) return ""
  if (s.portBusy && !s.appRunning) return "port-busy"
  if (!s.p2pDevice) return "no-p2p"
  return ""
}

// Local setup problems fail identically on every attempt; everything else
// may be the sink's flaky handshake and keeps the one automatic retry.
var LOCAL_FAILURES = ["port-busy", "no-monitor", "not-ready", "no-p2p", "not-installed"]

function shouldRetry(code) {
  return LOCAL_FAILURES.indexOf(String(code || "")) === -1
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
  // The engine's own stdout is the only record of the P2P handshake and
  // the sink's video session ("waiting for TV RTSP" vs "TV connected"),
  // so every run appends to a trimmed log: without it a stuck session
  // leaves no trace once its link state is all the widget shows.
  // FluxCast is Python: piped stdout is block-buffered, so without
  // PYTHONUNBUFFERED its own lines never reach the log when the engine is
  // signalled -- only its children's (ffmpeg, wf-recorder) stderr does.
  // Each run opens with a marker carrying its start epoch, so the probe
  // can hand the widget just this attempt's lines (see engineFailure).
  var logSetup = "log=\"$HOME/.local/state/kili.screencast/fluxcast.log\"; "
    + "mkdir -p \"${log%/*}\"; "
    + "if [ -f \"$log\" ]; then tail -n 200 \"$log\" > \"$log.tmp\" && mv -f \"$log.tmp\" \"$log\"; fi; "
    + "printf '=== kili.screencast run %s ===\\n' \"$(date +%s)\" >> \"$log\"; "
  var script = logSetup
    + "mon=$(" + findMon + "); "
    + "if [ -z \"$mon\" ]; then "
    + "for l in /tmp/.X[0-9]*-lock; do "
    + "[ -e \"$l\" ] || continue; "
    + "d=${l#/tmp/.X}; d=:${d%-lock}; "
    + "mon=$(DISPLAY=$d " + findMon + "); "
    + "[ -n \"$mon\" ] && break; "
    + "done; fi; "
    + "PYTHONUNBUFFERED=1 fluxcast --protocol wfd --wfd-timeout 4 --wfd-peer " + shQuote(peer)
    + " ${mon:+--monitor \"$mon\"} </dev/null 2>&1 | tee -a \"$log\" >/dev/null"
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
    RTSP_PORT: RTSP_PORT,
    engineFailure: engineFailure,
    diagnose: diagnose,
    cleanDetail: cleanDetail,
    errorMessage: errorMessage,
    steadyError: steadyError,
    shouldRetry: shouldRetry,
    linkText: linkText,
    dots: dots,
    iconFor: iconFor,
    LINKLESS_REAP_MS: LINKLESS_REAP_MS,
    shouldReapLinkless: shouldReapLinkless,
    RECOVERY_DELAY_MS: RECOVERY_DELAY_MS,
    WAITING_VIDEO_MS: WAITING_VIDEO_MS,
    shouldRecoverWaiting: shouldRecoverWaiting
  }
}
