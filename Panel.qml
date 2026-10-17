import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Miracast quick menu: the bar icon mirrors the sender state (idle, picker
// open, connecting, P2P connected) and the popup lists nearby displays
// (NetworkManager P2P discovery on open) with one adaptive action -- Connect
// opens the Network Displays picker, since sink connection has no CLI or
// D-Bus API and the window is unavoidable -- plus Disconnect, which quits
// the app and drops a lingering P2P link.
Panel {
  id: root
  moduleName: "kili.miracast"
  ipcTarget: "kili.miracast"

  property var status: Model.emptyStatus()
  property var sinks: []
  property bool scanning: false

  readonly property bool connected: status.connected === true
  readonly property bool connecting: status.connecting === true
  readonly property bool appRunning: status.appRunning === true
  readonly property bool linkActive: connected || connecting
  readonly property color dimForeground: root.bar ? Qt.darker(root.bar.foreground, 1.4) : Color.foreground

  function refresh(withScan) {
    var scan = withScan === true
    if (statusProc.running) {
      if (scan) scanRetryTimer.restart()
      return
    }
    scanning = scan
    statusProc.command = ["sh", "-c", probeScript, "sh", scan ? "scan" : "fast"]
    statusProc.running = true
  }

  function updateStatus(text) {
    var parsed = Model.parseStatus(text)
    status = parsed
    if (parsed.hasSinks) sinks = parsed.sinks
    scanning = false
    scanRetryTimer.stop()
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

  // NOTE: the pgrep/pkill pattern uses the bracket trick so the probe never
  // matches its own `sh -c` command line. `pgrep -x` cannot match this app:
  // the name is longer than the 15-char comm limit. Keep the unbracketed
  // literal out of these command lines or the probe self-matches.
  //
  // The probe also resolves friendly peer-name tiers: a peers.conf alias,
  // the NetworkManager P2P device name, and the peer IP's mDNS hostname
  // (".local" stripped). Model.peerLabel picks the first non-empty tier,
  // else the UI falls back to the raw NetworkManager string.
  //
  // With argv "scan" the probe additionally runs a P2P discovery sweep
  // (StartFind, 6s, read Peers, StopFind) and emits one `sink=` line per
  // peer plus a `sink_begin` marker. Scan mode runs only while the popup
  // is open; the background tick uses the fast mode without it.
  readonly property string probeScript: "pgrep -f 'gnome-network-display[s]' >/dev/null 2>&1 && echo app=running || echo app=stopped; out=$(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status 2>/dev/null); echo \"$out\"; line=$(echo \"$out\" | grep -m1 ':wifi-p2p:'); rest=${line#*:wifi-p2p:*:}; mac=$(printf '%s' \"${rest##* }\" | tr -d '\\\\'); alias_name=\"\"; nm_name=\"\"; mdns_name=\"\"; if [ -n \"$mac\" ]; then peers=\"$HOME/.config/omarchy/plugins/kili.miracast/peers.conf\"; [ -f \"$peers\" ] && alias_name=$(grep -i \"^$mac=\" \"$peers\" 2>/dev/null | head -n 1 | cut -d= -f2-); mac_up=$(printf '%s' \"$mac\" | tr 'a-z' 'A-Z'); for pp in $(busctl --system tree org.freedesktop.NetworkManager 2>/dev/null | grep -o \"/org/freedesktop/NetworkManager/WifiP2PPeer/[0-9]*\"); do hw=$(busctl --system get-property org.freedesktop.NetworkManager \"$pp\" org.freedesktop.NetworkManager.WifiP2PPeer HwAddress 2>/dev/null | sed -n 's/^s \"\\(.*\\)\"$/\\1/p'); hw_up=$(printf '%s' \"$hw\" | tr 'a-z' 'A-Z'); if [ \"$hw_up\" = \"$mac_up\" ]; then nm_name=$(busctl --system get-property org.freedesktop.NetworkManager \"$pp\" org.freedesktop.NetworkManager.WifiP2PPeer Name 2>/dev/null | sed -n 's/^s \"\\(.*\\)\"$/\\1/p'); break; fi; done; if [ -z \"$alias_name\" ]; then ip=$(ip neigh 2>/dev/null | grep -i \"$mac\" | head -n 1 | awk '{print $1}'); if [ -n \"$ip\" ]; then host=$(timeout 2 avahi-resolve-address \"$ip\" 2>/dev/null | awk '{print $2}'); mdns_name=${host%.local}; fi; fi; fi; echo \"alias_name=$alias_name\"; echo \"nm_name=$nm_name\"; echo \"mdns_name=$mdns_name\"; if [ \"$1\" = scan ]; then echo sink_begin; p2pdev=${line%%:*}; p2p_path=\"\"; if [ -n \"$p2pdev\" ]; then for dp in $(busctl --system tree org.freedesktop.NetworkManager 2>/dev/null | grep -o \"/org/freedesktop/NetworkManager/Devices/[0-9]*\"); do iface=$(busctl --system get-property org.freedesktop.NetworkManager \"$dp\" org.freedesktop.NetworkManager.Device Interface 2>/dev/null | sed -n 's/^s \"\\(.*\\)\"$/\\1/p'); if [ \"$iface\" = \"$p2pdev\" ]; then p2p_path=$dp; break; fi; done; fi; if [ -n \"$p2p_path\" ]; then busctl --system call org.freedesktop.NetworkManager \"$p2p_path\" org.freedesktop.NetworkManager.Device.WifiP2P StartFind a{sv} 0 >/dev/null 2>&1; sleep 6; for pp in $(busctl --system get-property org.freedesktop.NetworkManager \"$p2p_path\" org.freedesktop.NetworkManager.Device.WifiP2P Peers 2>/dev/null | grep -o \"/org/freedesktop/NetworkManager/WifiP2PPeer/[0-9]*\"); do s_name=$(busctl --system get-property org.freedesktop.NetworkManager \"$pp\" org.freedesktop.NetworkManager.WifiP2PPeer Name 2>/dev/null | sed -n 's/^s \"\\(.*\\)\"$/\\1/p'); s_hw=$(busctl --system get-property org.freedesktop.NetworkManager \"$pp\" org.freedesktop.NetworkManager.WifiP2PPeer HwAddress 2>/dev/null | sed -n 's/^s \"\\(.*\\)\"$/\\1/p'); s_wfd_n=$(busctl --system get-property org.freedesktop.NetworkManager \"$pp\" org.freedesktop.NetworkManager.WifiP2PPeer WfdIEs 2>/dev/null | awk '{print $2}'); s_wfd=0; [ \"$s_wfd_n\" -gt 0 ] 2>/dev/null && s_wfd=1; s_active=0; s_hw_up=$(printf '%s' \"$s_hw\" | tr 'a-z' 'A-Z'); if [ -n \"$mac_up\" ] && [ \"$s_hw_up\" = \"$mac_up\" ]; then s_active=1; fi; printf 'sink=%s\\t%s\\t%s\\t%s\\n' \"$s_name\" \"$s_hw\" \"$s_wfd\" \"$s_active\"; done; busctl --system call org.freedesktop.NetworkManager \"$p2p_path\" org.freedesktop.NetworkManager.Device.WifiP2P StopFind >/dev/null 2>&1; fi; fi"

  Process {
    id: statusProc
    command: ["sh", "-c", probeScript, "sh", "fast"]
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

          CursorSurface {
            required property var modelData
            required property int index

            width: column.width
            implicitHeight: Math.max(sinkName.implicitHeight, sinkBadge.implicitHeight) + Style.space(12)
            foreground: root.bar.foreground
            hasCursor: sinkMouse.containsMouse

            Text {
              id: sinkName
              textFormat: Text.PlainText
              text: modelData.name || "(unknown)"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
              anchors.left: parent.left
              anchors.right: sinkBadge.left
              anchors.leftMargin: Style.space(8)
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
            }

            Text {
              id: sinkBadge
              textFormat: Text.PlainText
              text: Model.sinkBadge(modelData)
              color: modelData.active ? Color.accent : root.dimForeground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
            }

            MouseArea {
              id: sinkMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              // No programmatic connect API exists (see header): a row opens
              // the picker for manual selection, like Connect does.
              onClicked: root.openPicker()
            }
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
