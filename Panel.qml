import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Screencast quick menu: the bar icon mirrors the sender state (idle,
// connecting, P2P connected) and the popup lists nearby displays
// (FluxCast Wi-Fi Direct discovery on open) and known displays (connection
// history). Clicking a row starts a windowless `fluxcast --protocol wfd`
// session to that sink -- no external window -- and Disconnect stops the
// engine and drops a lingering P2P link.
Panel {
  id: root
  moduleName: "kili.screencast"
  ipcTarget: "kili.screencast"

  property var status: Model.emptyStatus()
  property var sinks: []
  property bool scanning: false
  property int animFrame: 0
  property bool pendingConnect: false
  property string pendingPeer: ""
  // Exact selector for the outstanding click (always a MAC after
  // resolution). Kept so a dead handshake can be retried once.
  property string pendingSelector: ""
  // One automatic retry per click: the sink's own logs show an accepted
  // invitation sometimes forms no group, while an identical retry
  // succeeds. Consumed by the retry; a manual Disconnect disarms it.
  property bool retryArmed: false
  // Whether the current click's attempt ever got a link. Recovery only
  // applies to attempts that never connected: re-casting after a real
  // session dropped would be a surprise.
  property bool attemptLinked: false
  // Epoch ms when the link came up without video (0 = video or no link).
  property double waitingSince: 0
  // True when the running engine was started by this widget (popup click
  // or IPC connect). Only our own linkless-stuck engine is auto-reaped;
  // an externally started one is left alone.
  property bool ownEngine: false
  // Epoch ms when the engine was first seen linkless (0 = none).
  property double linklessSince: 0
  property bool wasConnected: false
  // Why the last attempt failed ("" = none): set where the widget gives
  // up, recovers, or sees a drop it did not cause; cleared by the next
  // click or by video actually flowing. The automatic retry keeps it, so
  // the popup says what is being retried.
  property string errorCode: ""
  property string errorText: ""
  // Epoch seconds when this widget last launched its engine: engine log
  // runs older than that belong to an earlier attempt. 0 while a foreign
  // engine runs, whose output never reaches our log.
  property double attemptEpoch: 0
  // The session carried video, so a later drop is a lost cast rather
  // than a failed connect.
  property bool hadVideo: false
  // Our own teardown is in flight: the drop it causes is not "lost".
  property bool tearingDown: false
  // Display name of the current or last peer, for error messages.
  property string lastPeer: ""
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
  readonly property color urgent: root.bar ? root.bar.urgent : Color.urgent
  readonly property var knownRows: Model.knownRows(root.sinks, status.knownRaw, Model.sessionMac(status))
  // The sink lists only show at rest: a live link or an outstanding
  // click collapses the popup to status plus Disconnect.
  readonly property bool showLists: !root.connected && !root.pendingConnect

  function refresh(withScan) {
    var scan = withScan === true
    // A full scan drives the radio off-channel for ~8 s and collapses an
    // in-progress P2P handshake: the sink joins, then never starts video.
    // While connecting or tearing down, downgrade to a fast probe; the
    // retry timer re-requests the scan once things settle.
    if (scan && (root.pendingConnect || disconnectProc.running)) {
      scan = false
      scanRetryTimer.restart()
    }
    if (statusProc.running) {
      if (scan) scanRetryTimer.restart()
      return
    }
    scanning = scan
    if (scan) animFrame = 0
    probeSeq = probeSeq + 1
    statusProc.command = ["sh", "-c", "\"$HOME/.config/omarchy/plugins/kili.screencast/probe.sh\" " + (scan ? "scan" : "fast")]
    statusProc.running = true
  }

  function updateStatus(text) {
    var parsed = Model.parseStatus(text)
    doneSeq = doneSeq + 1
    var linkWas = wasConnected
    if (parsed.connected && !wasConnected) {
      var mac = Model.sessionMac(parsed)
      if (Model.isMacAddress(mac)) recordPeer(mac, Model.peerLabel(parsed))
    }
    wasConnected = parsed.connected
    status = parsed
    if (parsed.connected) lastPeer = Model.peerLabel(parsed) || lastPeer
    // A foreign engine's output never reaches our log, so the log must
    // not explain its failures.
    if (parsed.appRunning && !ownEngine) attemptEpoch = 0
    // A cast that carried video dropped without our teardown: the sink
    // ended it or the radio lost it. Without this the popup just flips
    // back to Disconnected.
    if (linkWas && !parsed.connected && hadVideo && !tearingDown) fail("lost")
    if (!parsed.connected) hadVideo = false
    if (!parsed.connected && !parsed.appRunning) tearingDown = false
    // Reap our own engine when it stays linkless past the grace period:
    // no link in that long means stuck, and the Disconnected popup shows
    // no Disconnect button, so nothing else could clear it. The timer
    // runs during "Connecting..." too but only fires once progress is
    // over, and an externally started engine is never touched.
    if (!parsed.appRunning) {
      ownEngine = false
      linklessSince = 0
    } else if (parsed.connected) {
      linklessSince = 0
    } else if (linklessSince === 0) {
      linklessSince = Date.now()
    } else if (ownEngine && !pendingConnect && !disconnectProc.running
        && !recoveryTimer.running
        && Model.shouldReapLinkless(Date.now() - linklessSince)) {
      linklessSince = 0
      // A never-linked attempt whose engine wedged linkless gets the
      // same recovery as a dead one; a post-session engine just reaps.
      if (root.retryArmed && !root.attemptLinked && root.pendingSelector !== "") {
        fail("link-failed")
        recover()
      } else {
        if (root.errorCode === "") fail(root.attemptLinked ? "lost" : "link-failed")
        root.disconnect()
      }
    }
    if (!parsed.connected) root.waitingSince = 0
    if (recoveryTimer.running) {
      // Mid-recovery: our own teardown is still dropping the old link,
      // and the timer relaunches once it is gone. Judging this probe
      // would clear the outstanding click and cancel the retry.
    } else if (parsed.connected) {
      pendingConnect = false
      attemptLinked = true
      if (parsed.video) {
        // The attempt succeeded; no recovery may fire for it later, and
        // whatever failed on the way no longer applies.
        retryArmed = false
        waitingSince = 0
        hadVideo = true
        clearError()
      } else {
        if (root.waitingSince === 0) root.waitingSince = Date.now()
        if (parsed.fwBlocked) {
          // The firewall drops the sink's RTSP dial. Say so at once and
          // keep the link: the sink redials every ~20 s, so fixing the
          // firewall lets the next dial through without a new click.
          fail("firewall")
        } else if (Model.shouldRecoverWaiting(Date.now() - root.waitingSince)) {
          // Link up, no video: the sink's display app missed its trigger
          // and never starts on its own (observed for minutes). After a
          // patient wait, tear down and retry once; with no retry left,
          // keep the link but say why it hangs.
          if (root.retryArmed && root.pendingSelector !== "") {
            fail("no-video")
            recover()
          } else if (root.errorCode === "") {
            fail("no-video")
          }
        }
      }
    } else if (pendingConnect) {
      // Slow legitimate connects (scan retries plus NM activation) can
      // outlast the give-up timer, so a live handshake extends it.
      if (parsed.connecting) pendingTimer.restart()
      else if (doneSeq > pendingSeq && !parsed.appRunning) {
        // Our engine died before any link: the sink accepted the
        // invitation but the group handshake collapsed (its own logs
        // show an identical retry succeeding). Retry once, after a
        // settle pause -- relaunching into the same instant repeats
        // the failure. pendingConnect stays set: the click is still
        // outstanding, and Disconnect cancels the pending retry. Local
        // setup problems fail the same way every time and skip it.
        fail("engine-exit")
        if (root.retryArmed && root.pendingSelector !== "" && Model.shouldRetry(root.errorCode)) {
          retryArmed = false
          pendingTimer.restart()
          recoveryTimer.restart()
        } else {
          pendingConnect = false
          refresh(true)
        }
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
    var hist = "$HOME/.local/state/kili.screencast/history.tsv"
    var script = "f=\"" + hist + "\"; mkdir -p \"${f%/*}\"; touch \"$f\"; "
      + "nm=" + Model.shQuote(name) + "; "
      + "nm=$(printf '%s' \"$nm\" | tr -d '\\t\\n'); "
      + "tmp=\"$f.tmp.$$\"; "
      + "grep -vi \"^" + mac + "\t\" \"$f\" 2>/dev/null > \"$tmp\"; "
      + "printf '%s\\t%s\\t%s\\n' \"" + mac + "\" \"" + epoch + "\" \"$nm\" >> \"$tmp\"; "
      + "tail -n 20 \"$tmp\" > \"$tmp.new\"; mv -f \"$tmp.new\" \"$f\"; rm -f \"$tmp\""
    Quickshell.execDetached(["sh", "-c", script])
  }

  // Tear the attempt down and relaunch it once after the settle pause.
  // disconnect() cancels an outstanding click, so the click is re-armed
  // after it -- re-arming first left the retry timer nothing to retry.
  function recover() {
    retryArmed = false
    root.disconnect()
    pendingConnect = true
    pendingSeq = probeSeq
    pendingTimer.restart()
    recoveryTimer.restart()
  }

  function setError(code, detail) {
    errorCode = code
    errorText = Model.errorMessage(code, root.lastPeer, detail)
  }

  function clearError() {
    errorCode = ""
    errorText = ""
  }

  // Record why the attempt failed: its own engine log first, then the
  // firewall, then fallback -- what the widget itself observed.
  function fail(fallback) {
    var found = Model.diagnose(root.status, root.attemptEpoch, fallback)
    setError(found.code, found.detail)
  }

  // Popup and tooltip error: the last attempt's failure, else a steady
  // problem that would refuse a click. "" when nothing is wrong.
  function errorLine() {
    if (root.errorText !== "") return root.errorText
    return Model.errorMessage(Model.steadyError(root.status), "", "")
  }

  // Start a windowless cast to the clicked sink. Ignored while a
  // session is up, connecting, or tearing down, so a double click
  // cannot launch a second engine against the busy RTSP port. The popup
  // stays open to show the "Connecting to ..." progress; history is
  // recorded when the link actually comes up (see updateStatus), so
  // failed attempts never pollute Previous Connections. retry marks the
  // automatic relaunch, which keeps the error that caused it.
  function connectTo(peer, name, retry) {
    var selector = String(peer === undefined || peer === null ? "" : peer).trim()
    if (!Model.isPeerSelector(selector)) return
    if (root.appRunning || root.linkActive || root.pendingConnect || disconnectProc.running) return
    var display = String(name === undefined || name === null ? "" : name).trim()
    pendingPeer = (display === "" || display === "(unknown)") ? selector : display
    lastPeer = pendingPeer
    // A missing engine or a taken RTSP port fails every launch the same
    // way: refuse up front and say why instead of launching blind.
    var blocked = Model.steadyError(root.status)
    if (blocked !== "") {
      setError(blocked, "")
      return
    }
    if (retry !== true) clearError()
    pendingSelector = selector
    retryArmed = true
    attemptLinked = false
    waitingSince = 0
    hadVideo = false
    tearingDown = false
    attemptEpoch = Math.floor(Date.now() / 1000)
    pendingSeq = probeSeq
    pendingConnect = true
    ownEngine = true
    linklessSince = 0
    animFrame = 0
    pendingTimer.restart()
    Quickshell.execDetached(Model.connectCommand(selector))
    refresh(false)
  }

  // Popup link line: live "Connecting to <peer>" progress while a
  // click is outstanding ("Retrying" during the recovery pause), "Waiting
  // for beamer" when the link is up but the sink never started video,
  // otherwise the probed link state.
  function linkLine() {
    if (root.pendingConnect && !root.connected) {
      var verb = recoveryTimer.running ? "Retrying " : "Connecting to "
      return verb + root.pendingPeer + Model.dots(root.animFrame)
    }
    if (root.connected && !root.status.video) {
      return "Waiting for beamer" + Model.dots(root.animFrame)
    }
    return Model.linkText(root.status)
  }

  function disconnect() {
    if (disconnectProc.running) return
    tearingDown = true
    pendingConnect = false
    retryArmed = false
    waitingSince = 0
    recoveryTimer.stop()
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
    command: ["sh", "-c", "\"$HOME/.config/omarchy/plugins/kili.screencast/probe.sh\" fast"]
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

  // Drives the activity dots while a discovery sweep, a connect, a
  // disconnect, or a wait for the sink's video is in progress; idle
  // otherwise.
  Timer {
    interval: 400
    running: root.opened && (root.scanning || (root.pendingConnect && !root.connected) || disconnectProc.running || (root.connected && !root.status.video))
    repeat: true
    onTriggered: root.animFrame = root.animFrame + 1
  }

  // Gives up the "Connecting to ..." line if no link comes up: instant
  // engine failures would otherwise read as progress forever. An error
  // the engine already explained is kept.
  Timer {
    id: pendingTimer
    interval: 45000
    onTriggered: {
      if (root.connected) return
      root.pendingConnect = false
      if (root.errorCode === "") root.fail("link-failed")
    }
  }

  // The one automatic retry, after a settle pause: relaunching into the
  // same instant the previous handshake died just repeats it. Fires only
  // while the click is still outstanding; connectTo refuses while busy,
  // so a still-dropping link re-arms briefly instead of losing the retry.
  // retryArmed is cleared after the launch: connectTo arms it again for
  // the new attempt, which would otherwise retry forever.
  Timer {
    id: recoveryTimer
    interval: Model.RECOVERY_DELAY_MS
    onTriggered: {
      if (!root.pendingConnect || root.pendingSelector === "") return
      if (root.appRunning || root.linkActive || disconnectProc.running) {
        interval = 2000
        restart()
        return
      }
      interval = Model.RECOVERY_DELAY_MS
      // connectTo refuses while the click is outstanding; clear it for
      // the relaunch (it sets it again itself).
      root.pendingConnect = false
      root.connectTo(root.pendingSelector, root.pendingPeer, true)
      root.retryArmed = false
    }
  }

  // Scripted control for agents (OMCP tools call these over
  // `omarchy-shell kili.screencast <verb>`). Same code paths as popup
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
        video: root.status.video === true,
        engine: root.appRunning,
        wifi: root.status.wifiOn,
        peer: Model.peerLabel(root.status),
        // The popup's error line and its stable code ("" when none).
        error: root.errorLine(),
        errorCode: root.errorCode !== "" ? root.errorCode : Model.steadyError(root.status)
      })
    }

    function connect(peer: string): string {
      if (!Model.isPeerSelector(peer)) return JSON.stringify({ ok: false, reason: "invalid peer" })
      if (root.appRunning || root.linkActive || root.pendingConnect || disconnectProc.running) {
        return JSON.stringify({ ok: false, reason: "busy" })
      }
      var blocked = Model.steadyError(root.status)
      if (blocked !== "") {
        return JSON.stringify({ ok: false, reason: blocked, error: Model.errorMessage(blocked, "", "") })
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
    tooltipText: Model.tooltipText(root.status, root.errorLine())
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
            text: "SCREENCAST"
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

        // Why the last attempt failed, or what would refuse a click, in
        // the shell's urgent color; wrapped so a remedy command stays
        // readable in full.
        Text {
          textFormat: Text.PlainText
          visible: root.errorLine() !== ""
          height: visible ? implicitHeight : 0
          text: root.errorLine()
          color: root.urgent
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
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
          // where it acts as cancel. It never shows on a Disconnected
          // popup: a linkless-stuck engine is auto-reaped instead (see
          // updateStatus), so nothing needs a manual button there.
          visible: root.linkActive || root.pendingConnect || disconnectProc.running
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
