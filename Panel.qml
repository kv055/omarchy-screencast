import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Miracast quick menu: the bar icon mirrors the sender state (idle,
// connecting, P2P connected) and the popup lists nearby displays
// (FluxCast Wi-Fi Direct discovery on open) and known displays (connection
// history). Clicking a row starts a windowless `fluxcast --protocol wfd`
// session to that sink -- no external window -- and Disconnect stops the
// engine and drops a lingering P2P link.
Panel {
  id: root
  moduleName: "kili.miracast"
  ipcTarget: "kili.miracast"

  property var status: Model.emptyStatus()
  property var sinks: []
  property bool scanning: false
  property int animFrame: 0
  property bool pendingConnect: false
  property string pendingPeer: ""
  property bool wasConnected: false
  // Probe generations: a completion only judges a click when a probe
  // launched after that click completed, so stale in-flight results
  // can neither clear a fresh "Connecting..." nor record history twice.
  property int probeSeq: 0
  property int doneSeq: 0
  property int pendingSeq: -1

  readonly property bool connected: status.connected === true
  readonly property bool connecting: status.connecting === true
  readonly property bool appRunning: status.appRunning === true
  readonly property bool linkActive: connected || connecting
  readonly property color dimForeground: root.bar ? Qt.darker(root.bar.foreground, 1.4) : Color.foreground
  readonly property var knownRows: Model.knownRows(root.sinks, status.knownRaw, Model.sessionMac(status))
  // The sink lists only show at rest: a live link or an outstanding
  // click collapses the popup to status plus Disconnect.
  readonly property bool showLists: !root.connected && !root.pendingConnect

  function refresh(withScan) {
    var scan = withScan === true
    if (statusProc.running) {
      if (scan) scanRetryTimer.restart()
      return
    }
    scanning = scan
    if (scan) animFrame = 0
    probeSeq = probeSeq + 1
    statusProc.command = ["sh", "-c", "\"$HOME/.config/omarchy/plugins/kili.miracast/probe.sh\" " + (scan ? "scan" : "fast")]
    statusProc.running = true
  }

  function updateStatus(text) {
    var parsed = Model.parseStatus(text)
    doneSeq = doneSeq + 1
    if (parsed.connected && !wasConnected) {
      var mac = Model.sessionMac(parsed)
      if (Model.isMacAddress(mac)) recordPeer(mac, Model.peerLabel(parsed))
    }
    wasConnected = parsed.connected
    status = parsed
    if (parsed.connected) {
      pendingConnect = false
    } else if (pendingConnect) {
      // Slow legitimate connects (scan retries plus NM activation) can
      // outlast the give-up timer, so a live handshake extends it; an
      // engine that died before its first post-click result clears it
      // and rescans, so a retry resolves against fresh discovery.
      if (parsed.connecting) pendingTimer.restart()
      else if (doneSeq > pendingSeq && !parsed.appRunning) {
        pendingConnect = false
        refresh(true)
      }
    }
    if (parsed.hasSinks) {
      sinks = parsed.sinks
      scanRetryTimer.stop()
    }
    // Fast ticks carry no sinks: re-derive badges from the live session
    // MAC so a dropped link clears its row without waiting for a rescan.
    sinks = Model.refreshSinkActives(sinks, Model.sessionMac(parsed))
    scanning = false
  }

  // Best-effort history append (atomic rename, LRU-capped at 20). Runs at
  // most once per connection; a concurrent probe may read the pre-rename
  // file, which simply delays the new entry by one tick.
  function recordPeer(mac, name) {
    var epoch = Math.floor(Date.now() / 1000)
    var hist = "$HOME/.local/state/kili.miracast/history.tsv"
    var script = "f=\"" + hist + "\"; mkdir -p \"${f%/*}\"; touch \"$f\"; "
      + "nm=" + Model.shQuote(name) + "; "
      + "nm=$(printf '%s' \"$nm\" | tr -d '\\t\\n'); "
      + "tmp=\"$f.tmp.$$\"; "
      + "grep -vi \"^" + mac + "\t\" \"$f\" 2>/dev/null > \"$tmp\"; "
      + "printf '%s\\t%s\\t%s\\n' \"" + mac + "\" \"" + epoch + "\" \"$nm\" >> \"$tmp\"; "
      + "tail -n 20 \"$tmp\" > \"$tmp.new\"; mv -f \"$tmp.new\" \"$f\"; rm -f \"$tmp\""
    Quickshell.execDetached(["sh", "-c", script])
  }

  // Start a windowless cast to the clicked sink. Ignored while a
  // session is up, connecting, or tearing down, so a double click
  // cannot launch a second engine against the busy RTSP port. The popup
  // stays open to show the "Connecting to ..." progress; history is
  // recorded when the link actually comes up (see updateStatus), so
  // failed attempts never pollute Previous Connections.
  function connectTo(peer, name) {
    var selector = String(peer === undefined || peer === null ? "" : peer).trim()
    if (!Model.isPeerSelector(selector)) return
    if (root.appRunning || root.linkActive || root.pendingConnect || disconnectProc.running) return
    var display = String(name === undefined || name === null ? "" : name).trim()
    pendingPeer = (display === "" || display === "(unknown)") ? selector : display
    pendingSeq = probeSeq
    pendingConnect = true
    animFrame = 0
    pendingTimer.restart()
    Quickshell.execDetached(Model.connectCommand(selector))
    refresh(false)
  }

  // Popup link line: live "Connecting to <peer>" progress while a
  // click is outstanding, otherwise the probed link state.
  function linkLine() {
    if (root.pendingConnect && !root.connected) {
      return "Connecting to " + root.pendingPeer + Model.dots(root.animFrame)
    }
    return Model.linkText(root.status)
  }

  function disconnect() {
    if (disconnectProc.running) return
    pendingConnect = false
    pendingTimer.stop()
    animFrame = 0
    disconnectProc.running = true
  }

  // Opening rescans, unless already connected: grouped peers stop
  // answering discovery, so a mid-link scan would only wipe the good
  // cached list. An empty cache still scans.
  onOpenedChanged: if (opened) refresh(!root.connected || root.sinks.length === 0)
  Component.onCompleted: refresh(false)

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Status comes from probe.sh in this plugin's directory (see there for
  // the output format and the pgrep bracket-trick note). Scan mode runs
  // only while the popup is open; the background tick uses the fast mode.
  Process {
    id: statusProc
    command: ["sh", "-c", "\"$HOME/.config/omarchy/plugins/kili.miracast/probe.sh\" fast"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.updateStatus(text) }
  }

  // Engine teardown comes from Model.disconnectCommand (SIGINT first so
  // FluxCast cleans up after itself, then an nmcli disconnect for a
  // lingering P2P link). The command is fixed, so it is read once here.
  Process {
    id: disconnectProc
    command: Model.disconnectCommand()
    onExited: settleTimer.restart()
  }

  Timer {
    id: settleTimer
    interval: 1200
    // Fast refresh only: the cached list returns instantly, and no
    // background scan can wipe it while the peer re-advertises.
    // Reopening the popup rescans.
    onTriggered: root.refresh(false)
  }

  Timer {
    id: scanRetryTimer
    interval: 2000
    onTriggered: if (root.opened) root.refresh(true)
  }

  Timer {
    interval: 15000
    running: true
    repeat: true
    onTriggered: root.refresh(false)
  }

  // Fast ticks while the popup is open or a connect is outstanding: link
  // changes surface in ~1.5 s instead of up to a 15 s tick. Each fast
  // probe costs ~90 ms and drops harmlessly when a scan is running.
  Timer {
    interval: 1500
    running: root.opened || (root.pendingConnect && !root.connected)
    repeat: true
    onTriggered: root.refresh(false)
  }

  // Drives the activity dots while a discovery sweep, a connect, or
  // a disconnect is in progress; idle otherwise.
  Timer {
    interval: 400
    running: root.opened && (root.scanning || (root.pendingConnect && !root.connected) || disconnectProc.running)
    repeat: true
    onTriggered: root.animFrame = root.animFrame + 1
  }

  // Gives up the "Connecting to ..." line if no link comes up: instant
  // engine failures would otherwise read as progress forever.
  Timer {
    id: pendingTimer
    interval: 45000
    onTriggered: if (!root.connected) root.pendingConnect = false
  }

  // Scripted control for agents (OMCP tools call these over
  // `omarchy-shell kili.miracast <verb>`). Same code paths as popup
  // clicks; every verb answers a JSON object.
  IpcHandler {
    target: root.ipcTarget

    function status(): string {
      // Answers from cache, but kicks a refresh so consecutive polls
      // converge on fresh state.
      root.refresh(false)
      return JSON.stringify({
        connected: root.connected,
        connecting: root.connecting,
        engine: root.appRunning,
        wifi: root.status.wifiOn,
        peer: Model.peerLabel(root.status)
      })
    }

    function connect(peer: string): string {
      if (!Model.isPeerSelector(peer)) return JSON.stringify({ ok: false, reason: "invalid peer" })
      if (root.appRunning || root.linkActive || root.pendingConnect || disconnectProc.running) {
        return JSON.stringify({ ok: false, reason: "busy" })
      }
      // Names resolve against cached discovery to an exact MAC first:
      // FluxCast itself would cast to the first substring match.
      var resolved = Model.resolvePeer(root.sinks, peer)
      if (resolved.error) {
        root.refresh(true)
        return JSON.stringify({ ok: false, reason: resolved.error })
      }
      root.connectTo(resolved.mac, resolved.name || peer)
      return JSON.stringify({ ok: true })
    }

    function disconnect(): string {
      if (!root.linkActive && !root.appRunning && !root.pendingConnect) {
        return JSON.stringify({ ok: false, reason: "idle" })
      }
      root.disconnect()
      return JSON.stringify({ ok: true })
    }
  }

  component SinkRow: CursorSurface {
    signal activated

    required property string label
    required property string badge
    required property color badgeColor

    foreground: root.bar.foreground
    hasCursor: rowMouse.containsMouse
    implicitHeight: Math.max(rowName.implicitHeight, rowBadge.implicitHeight) + Style.space(12)

    Text {
      id: rowName
      textFormat: Text.PlainText
      text: label
      color: root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
      anchors.left: parent.left
      anchors.right: rowBadge.left
      anchors.leftMargin: Style.space(8)
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      id: rowBadge
      textFormat: Text.PlainText
      text: badge
      color: badgeColor
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
    }

    MouseArea {
      id: rowMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: activated()
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.iconFor(root.status)
    active: root.connected
    activeColor: Color.accent
    dimmed: !root.connected && !root.appRunning
    tooltipText: Model.tooltipText(root.status)
    onPressed: function(b) {
      if (b === Qt.RightButton) root.refresh(root.opened)
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroTitle.implicitHeight, heroStatus.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            text: Model.iconFor(root.status)
            color: root.connected ? Color.accent : root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Text {
            id: heroTitle
            text: "MIRACAST"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
            font.letterSpacing: 1.2
            elide: Text.ElideRight
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(12)
            anchors.right: heroStatus.left
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
          }

          Text {
            id: heroStatus
            textFormat: Text.PlainText
            text: Model.heroStatus(root.status, root.pendingConnect || root.connecting || disconnectProc.running)
            color: root.connected ? Color.accent : root.dimForeground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1.2
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        Text {
          textFormat: Text.PlainText
          visible: root.linkLine() !== ""
          height: visible ? implicitHeight : 0
          text: root.linkLine()
          color: root.dimForeground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
          width: parent.width
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        PanelSectionHeader {
          visible: root.showLists
          height: visible ? implicitHeight : 0
          text: "AVAILABLE"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Text {
          textFormat: Text.PlainText
          visible: root.showLists && root.sinks.length === 0
          height: visible ? implicitHeight : 0
          text: root.scanning ? "Scanning" + Model.dots(root.animFrame) : "No displays found"
          color: root.dimForeground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
          width: parent.width
        }

        Repeater {
          model: root.showLists ? root.sinks : []

          SinkRow {
            required property var modelData
            required property int index

            width: column.width
            label: modelData.name || "(unknown)"
            badge: Model.sinkBadge(modelData)
            badgeColor: modelData.active ? Color.accent : root.dimForeground
            // Rows are the connect action: a click starts a windowless
            // FluxCast session straight to this sink.
            onActivated: root.connectTo(modelData.hw, modelData.name)
          }
        }

        PanelSeparator {
          visible: root.showLists && root.knownRows.length > 0
          height: visible ? implicitHeight : 0
          foreground: root.bar.foreground
        }

        PanelSectionHeader {
          visible: root.showLists && root.knownRows.length > 0
          height: visible ? implicitHeight : 0
          text: "PREVIOUS CONNECTIONS"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Repeater {
          model: root.showLists ? root.knownRows : []

          SinkRow {
            required property var modelData
            required property int index

            width: column.width
            label: modelData.label
            badge: modelData.badge
            badgeColor: modelData.active ? Color.accent : root.dimForeground
            // Known sinks connect directly by MAC, no scan needed.
            onActivated: root.connectTo(modelData.mac, modelData.name)
          }
        }

        Button {
          width: parent.width
          // Rows are the connect action; the button stops the engine
          // and/or tears down a link -- including a pending click,
          // where it acts as cancel, and an engine whose link died
          // underneath it, which would otherwise block new clicks.
          visible: root.linkActive || root.appRunning || root.pendingConnect
          height: visible ? implicitHeight : 0
          text: disconnectProc.running ? "Disconnecting" + Model.dots(root.animFrame) : "Disconnect"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          bordered: true
          onClicked: root.disconnect()
        }
      }
    }
  }
}
