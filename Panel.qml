import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Miracast quick menu: the bar icon mirrors the sender state (idle, picker
// open, connecting, P2P connected) and the popup lists nearby displays
// (NetworkManager P2P discovery on open) and known displays (connection
// history), with one adaptive action -- clicking a row opens the Network
// Displays picker, since sink connection has no CLI or D-Bus API and the
// window is unavoidable -- plus Disconnect, which quits the app and drops
// a lingering P2P link.
Panel {
  id: root
  moduleName: "kili.miracast"
  ipcTarget: "kili.miracast"

  property var status: Model.emptyStatus()
  property var sinks: []
  property bool scanning: false
  property bool wasConnected: false

  readonly property bool connected: status.connected === true
  readonly property bool connecting: status.connecting === true
  readonly property bool appRunning: status.appRunning === true
  readonly property bool linkActive: connected || connecting
  readonly property color dimForeground: root.bar ? Qt.darker(root.bar.foreground, 1.4) : Color.foreground
  readonly property var knownRows: Model.knownRows(root.sinks, status.knownRaw, Model.sessionMac(status))

  function refresh(withScan) {
    var scan = withScan === true
    if (statusProc.running) {
      if (scan) scanRetryTimer.restart()
      return
    }
    scanning = scan
    statusProc.command = ["sh", "-c", "\"$HOME/.config/omarchy/plugins/kili.miracast/probe.sh\" " + (scan ? "scan" : "fast")]
    statusProc.running = true
  }

  function updateStatus(text) {
    var parsed = Model.parseStatus(text)
    if (parsed.connected && !wasConnected) {
      var mac = Model.sessionMac(parsed)
      if (Model.isMacAddress(mac)) recordPeer(mac, Model.peerLabel(parsed))
    }
    wasConnected = parsed.connected
    status = parsed
    if (parsed.hasSinks) sinks = parsed.sinks
    scanning = false
    scanRetryTimer.stop()
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
      + "grep -v \"^" + mac + "\t\" \"$f\" 2>/dev/null > \"$tmp\"; "
      + "printf '%s\\t%s\\t%s\\n' \"" + mac + "\" \"" + epoch + "\" \"$nm\" >> \"$tmp\"; "
      + "tail -n 20 \"$tmp\" > \"$tmp.new\"; mv -f \"$tmp.new\" \"$f\"; rm -f \"$tmp\""
    Quickshell.execDetached(["sh", "-c", script])
  }

  function openPicker() {
    Quickshell.execDetached(["gnome-network-displays"])
    close()
  }

  function disconnect() {
    if (disconnectProc.running) return
    disconnectProc.running = true
  }

  onOpenedChanged: if (opened) refresh(true)
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

  Process {
    id: disconnectProc
    command: ["sh", "-c", "pkill -f 'gnome-network-display[s]' 2>/dev/null; sleep 1; for dev in $(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2==\"wifi-p2p\"{print $1}'); do nmcli device disconnect \"$dev\" >/dev/null 2>&1; done; true"]
    onExited: settleTimer.restart()
  }

  Timer {
    id: settleTimer
    interval: 1200
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
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

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

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(12)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "MIRACAST"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              textFormat: Text.PlainText
              text: Model.statusText(root.status)
              color: root.dimForeground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }
        }

        Text {
          textFormat: Text.PlainText
          text: Model.linkText(root.status)
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
          text: "NEARBY DISPLAYS"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Text {
          textFormat: Text.PlainText
          visible: root.sinks.length === 0
          height: visible ? implicitHeight : 0
          text: root.scanning ? "Scanning..." : "No displays found"
          color: root.dimForeground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
          width: parent.width
        }

        Repeater {
          model: root.sinks

          SinkRow {
            required property var modelData
            required property int index

            width: column.width
            label: modelData.name || "(unknown)"
            badge: Model.sinkBadge(modelData)
            badgeColor: modelData.active ? Color.accent : root.dimForeground
            // No programmatic connect API exists (see header): a row opens
            // the picker for manual selection, like Connect does.
            onActivated: root.openPicker()
          }
        }

        PanelSectionHeader {
          visible: root.knownRows.length > 0
          height: visible ? implicitHeight : 0
          text: "KNOWN DISPLAYS"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
        }

        Repeater {
          model: root.knownRows

          SinkRow {
            required property var modelData
            required property int index

            width: column.width
            label: modelData.label
            badge: modelData.badge
            badgeColor: modelData.active ? Color.accent : root.dimForeground
            onActivated: root.openPicker()
          }
        }

        Button {
          width: parent.width
          // Rows are the connect action when sinks are listed; the button
          // remains for tearing down a link or opening a blind picker.
          visible: root.linkActive || root.sinks.length === 0
          height: visible ? implicitHeight : 0
          text: root.linkActive ? (disconnectProc.running ? "Working..." : "Disconnect") : "Connect..."
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          bordered: true
          onClicked: root.linkActive ? root.disconnect() : root.openPicker()
        }
      }
    }
  }
}
