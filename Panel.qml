import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Miracast quick menu: the bar icon mirrors the sender state (idle, picker
// open, P2P connected) and the popup offers Connect -- open or focus the
// Network Displays picker, since sink selection has no CLI and the window is
// unavoidable -- plus Disconnect, which quits the app and drops a lingering
// P2P link.
Panel {
  id: root
  moduleName: "kili.miracast"
  ipcTarget: "kili.miracast"

  property var status: Model.emptyStatus()

  readonly property bool connected: status.connected === true
  readonly property bool connecting: status.connecting === true
  readonly property bool appRunning: status.appRunning === true
  readonly property bool linkActive: connected || connecting
  readonly property color dimForeground: root.bar ? Qt.darker(root.bar.foreground, 1.4) : Color.foreground

  function refresh() {
    if (!statusProc.running) statusProc.running = true
  }

  function updateStatus(text) {
    status = Model.parseStatus(text)
  }

  function openPicker() {
    Quickshell.execDetached(["gnome-network-displays"])
    close()
  }

  function disconnect() {
    if (disconnectProc.running) return
    disconnectProc.running = true
  }

  onOpenedChanged: if (opened) refresh()
  Component.onCompleted: refresh()

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
  Process {
    id: statusProc
    command: ["sh", "-c", "pgrep -f 'gnome-network-display[s]' >/dev/null 2>&1 && echo app=running || echo app=stopped; out=$(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status 2>/dev/null); echo \"$out\"; line=$(echo \"$out\" | grep -m1 ':wifi-p2p:'); rest=${line#*:wifi-p2p:*:}; mac=$(printf '%s' \"${rest##* }\" | tr -d '\\\\'); alias_name=\"\"; nm_name=\"\"; mdns_name=\"\"; if [ -n \"$mac\" ]; then peers=\"$HOME/.config/omarchy/plugins/kili.miracast/peers.conf\"; [ -f \"$peers\" ] && alias_name=$(grep -i \"^$mac=\" \"$peers\" 2>/dev/null | head -n 1 | cut -d= -f2-); mac_up=$(printf '%s' \"$mac\" | tr 'a-z' 'A-Z'); for pp in $(busctl --system tree org.freedesktop.NetworkManager 2>/dev/null | grep -o \"/org/freedesktop/NetworkManager/WifiP2PPeer/[0-9]*\"); do hw=$(busctl --system get-property org.freedesktop.NetworkManager \"$pp\" org.freedesktop.NetworkManager.WifiP2PPeer HwAddress 2>/dev/null | sed -n 's/^s \"\\(.*\\)\"$/\\1/p'); hw_up=$(printf '%s' \"$hw\" | tr 'a-z' 'A-Z'); if [ \"$hw_up\" = \"$mac_up\" ]; then nm_name=$(busctl --system get-property org.freedesktop.NetworkManager \"$pp\" org.freedesktop.NetworkManager.WifiP2PPeer Name 2>/dev/null | sed -n 's/^s \"\\(.*\\)\"$/\\1/p'); break; fi; done; if [ -z \"$alias_name\" ]; then ip=$(ip neigh 2>/dev/null | grep -i \"$mac\" | head -n 1 | awk '{print $1}'); if [ -n \"$ip\" ]; then host=$(timeout 2 avahi-resolve-address \"$ip\" 2>/dev/null | awk '{print $2}'); mdns_name=${host%.local}; fi; fi; fi; echo \"alias_name=$alias_name\"; echo \"nm_name=$nm_name\"; echo \"mdns_name=$mdns_name\""]
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
    onTriggered: root.refresh()
  }

  Timer {
    interval: 15000
    running: true
    repeat: true
    onTriggered: root.refresh()
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
      if (b === Qt.RightButton) root.refresh()
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

        Button {
          width: parent.width
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
