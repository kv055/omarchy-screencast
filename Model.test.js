const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const M = require("./Model.js");

// Grounded in live `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`
// output (peer MAC anonymized). Terse mode backslash-escapes the colons.
const NMCLI_CONNECTED =
  "app=running\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "tailscale0:tun:connected (externally):tailscale0\n" +
  "lo:loopback:connected (externally):lo\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "peer_mac=\n" +
  "known_begin\n" +
  "known=9A:03:CF:FC:40:A3\t1792223000\t\tU0320\n";

const NMCLI_CONNECTED_NAMED =
  "app=running\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "nm_name=U0320\n" +
  "mdns_name=Android\n" +
  "peer_mac=AA:BB:CC:DD:EE:FF\n" +
  "known_begin\n";

const NMCLI_CONNECTED_MDNS_ONLY =
  "app=running\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "nm_name=\n" +
  "mdns_name=Android\n" +
  "peer_mac=\n" +
  "known_begin\n";

const NMCLI_CONNECTING =
  "app=running\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connecting (configuring):Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "peer_mac=\n" +
  "known_begin\n";

const NMCLI_IDLE =
  "app=stopped\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "peer_mac=\n" +
  "known_begin\n" +
  "known=9A:03:CF:FC:40:A3\t1792223000\t\tU0320\n";

const NMCLI_UNAVAILABLE =
  "app=stopped\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:unavailable:\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "peer_mac=\n" +
  "known_begin\n";

const NMCLI_ENGINE_RUNNING =
  "app=running\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "peer_mac=\n" +
  "known_begin\n";

const NMCLI_NO_P2P =
  "app=stopped\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "peer_mac=\n" +
  "known_begin\n";

// FluxCast-era session: NetworkManager names the link "FluxCast WFD" instead
// of "Wi-Fi P2P Peer <MAC>", so the peer MAC arrives on its own line,
// resolved by the probe from the P2P group interface neighbors.
const FLUXCAST_CONNECTED =
  "app=running\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:FluxCast WFD\n" +
  "nm_name=U0320\n" +
  "mdns_name=\n" +
  "peer_mac=9A:03:CF:FC:40:A3\n" +
  "video=yes\n" +
  "known_begin\n" +
  "known=9A:03:CF:FC:40:A3\t1792223000\t\tU0320\n";

// Same link but the sink never started its video session: joined the P2P
// group, no established RTSP. Must read as Waiting, not Connected.
const FLUXCAST_WAITING =
  "app=running\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:FluxCast WFD\n" +
  "nm_name=U0320\n" +
  "mdns_name=\n" +
  "peer_mac=9A:03:CF:FC:40:A3\n" +
  "video=no\n" +
  "known_begin\n" +
  "known=9A:03:CF:FC:40:A3\t1792223000\t\tU0320\n";

// Scan-mode output: fast block plus sink and known sections. The beamer is
// both nearby and known, so the merge must show it exactly once (nearby).
const NMCLI_SCAN =
  "app=stopped\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "peer_mac=\n" +
  "known_begin\n" +
  "known=9A:03:CF:FC:40:A3\t1792223068\t\tU0320\n" +
  "known=C0:FF:EE:00:11:22\t1791000000\t\tOld Projector\n" +
  "sink_begin\n" +
  "sink=U0320\t9A:03:CF:FC:40:A3\t1\t0\n" +
  "sink=Emilias 2. Fire TV Stick\tC6:95:00:71:95:A3\t0\t0\n" +
  "sink=B\u00fcro: TV=neu\tAA:BB:CC:DD:EE:FF\t1\t0\n";

const NMCLI_SCAN_EMPTY =
  "app=stopped\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "peer_mac=\n" +
  "known_begin\n" +
  "sink_begin\n";

const NOW = 1792223100;

describe("splitTerse", () => {
  it("splits on unescaped colons and unescapes colons", () => {
    assert.deepEqual(
      M.splitTerse("p2p-dev-wlp0s20f3:wifi-p2p:connected:Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF"),
      ["p2p-dev-wlp0s20f3", "wifi-p2p", "connected", "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF"]
    );
  });

  it("keeps empty trailing fields", () => {
    assert.deepEqual(
      M.splitTerse("p2p-dev-wlp0s20f3:wifi-p2p:disconnected:"),
      ["p2p-dev-wlp0s20f3", "wifi-p2p", "disconnected", ""]
    );
  });

  it("tolerates empty input", () => {
    assert.deepEqual(M.splitTerse(""), [""]);
    assert.deepEqual(M.splitTerse(null), [""]);
  });
});

describe("parseStatus", () => {
  it("parses a live connected session", () => {
    assert.deepEqual(M.parseStatus(NMCLI_CONNECTED), {
      appRunning: true,
      p2pDevice: "p2p-dev-wlp0s20f3",
      p2pState: "connected",
      peer: "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF",
      nmName: "",
      mdnsName: "",
      peerMac: "",
      connected: true,
      connecting: false,
      video: false,
      wifiOn: true,
      sinks: [],
      hasSinks: false,
      knownRaw: [
        { mac: "9A:03:CF:FC:40:A3", epoch: 1792223000, name: "U0320" }
      ],
      probed: true,
      engineInstalled: true,
      portBusy: false,
      fwBlocked: false,
      logRun: 0,
      logLines: []
    });
  });

  it("reads both name tiers", () => {
    const s = M.parseStatus(NMCLI_CONNECTED_NAMED);
    assert.equal(s.nmName, "U0320");
    assert.equal(s.mdnsName, "Android");
    assert.equal(s.connected, true);
  });

  it("detects the handshake state", () => {
    const s = M.parseStatus(NMCLI_CONNECTING);
    assert.equal(s.connected, false);
    assert.equal(s.connecting, true);
    assert.equal(s.peer, "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF");
  });

  it("parses the idle state", () => {
    const s = M.parseStatus(NMCLI_IDLE);
    assert.equal(s.appRunning, false);
    assert.equal(s.p2pDevice, "p2p-dev-wlp0s20f3");
    assert.equal(s.connected, false);
    assert.equal(s.connecting, false);
    assert.equal(s.peer, "");
  });

  it("sees the running engine without a link", () => {
    const s = M.parseStatus(NMCLI_ENGINE_RUNNING);
    assert.equal(s.appRunning, true);
    assert.equal(s.connected, false);
  });

  it("handles a missing P2P device", () => {
    const s = M.parseStatus(NMCLI_NO_P2P);
    assert.equal(s.p2pDevice, "");
    assert.equal(s.connected, false);
  });

  it("never throws on empty or garbage input", () => {
    for (const bad of ["", "\n", "garbage\n:nope", null, undefined]) {
      const s = M.parseStatus(bad);
      assert.equal(s.connected, false);
      assert.equal(s.connecting, false);
      assert.equal(s.appRunning, false);
    }
  });
});

describe("fluxcast session", () => {
  it("parses a FluxCast WFD link with its peer MAC line", () => {
    const s = M.parseStatus(FLUXCAST_CONNECTED);
    assert.equal(s.appRunning, true);
    assert.equal(s.connected, true);
    assert.equal(s.connecting, false);
    assert.equal(s.peer, "FluxCast WFD");
    assert.equal(s.peerMac, "9A:03:CF:FC:40:A3");
    assert.equal(M.peerLabel(s), "U0320");
    assert.equal(M.linkText(s), "U0320");
    assert.equal(M.heroStatus(s, false), "Connected");
    assert.equal(M.tooltipText(s), "Screencast: U0320");
  });

  it("prefers the peer MAC line over the legacy peer string", () => {
    assert.equal(
      M.sessionMac({ peerMac: "9A:03:CF:FC:40:A3", peer: "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF" }),
      "9A:03:CF:FC:40:A3"
    );
  });

  it("falls back to the legacy peer string without a MAC line", () => {
    assert.equal(M.sessionMac({ peerMac: "", peer: "Wi-Fi P2P Peer 9A:03:CF:FC:40:A3" }), "9A:03:CF:FC:40:A3");
    assert.equal(M.sessionMac({ peer: "FluxCast WFD" }), "");
    assert.equal(M.sessionMac({ peer: "" }), "");
    assert.equal(M.sessionMac(null), "");
  });
});

describe("sink discovery", () => {
  it("parses scan results with flags", () => {
    const s = M.parseStatus(NMCLI_SCAN);
    assert.equal(s.hasSinks, true);
    assert.deepEqual(s.sinks, [
      { name: "U0320", hw: "9A:03:CF:FC:40:A3", wfd: true, active: false },
      { name: "Emilias 2. Fire TV Stick", hw: "C6:95:00:71:95:A3", wfd: false, active: false },
      { name: "B\u00fcro: TV=neu", hw: "AA:BB:CC:DD:EE:FF", wfd: true, active: false }
    ]);
    assert.equal(s.sinks[2].name.codePointAt(1), 0xFC);
  });

  it("reports an empty scan distinctly from no scan", () => {
    const empty = M.parseStatus(NMCLI_SCAN_EMPTY);
    assert.equal(empty.hasSinks, true);
    assert.deepEqual(empty.sinks, []);
    const fast = M.parseStatus(NMCLI_IDLE);
    assert.equal(fast.hasSinks, false);
    assert.deepEqual(fast.sinks, []);
  });

  it("tolerates malformed sink lines", () => {
    assert.deepEqual(M.parseSink(""), { name: "(unknown)", hw: "", wfd: false, active: false });
    assert.deepEqual(M.parseSink("JustAName"), { name: "JustAName", hw: "", wfd: false, active: false });
    assert.deepEqual(M.parseSink("\tAA:BB:CC:DD:EE:FF\t1\t0").name, "(unknown)");
  });

  it("badges the active sink, displays, and plain devices", () => {
    const active = { name: "U0320", hw: "9A:03:CF:FC:40:A3", wfd: true, active: true };
    const s = M.parseStatus(NMCLI_SCAN);
    assert.equal(M.sinkBadge(active), "Connected");
    assert.equal(M.sinkBadge(s.sinks[1]), "Device");
    assert.equal(M.sinkBadge(s.sinks[2]), "Display");
  });

  it("clears stale Connected badges once the link drops", () => {
    const cached = [
      { name: "U0320", hw: "9A:03:CF:FC:40:A3", wfd: true, active: true },
      { name: "Other", hw: "C6:95:00:71:95:A3", wfd: false, active: false }
    ];
    const cleared = M.refreshSinkActives(cached, "");
    assert.deepEqual(cleared.map((s) => s.active), [false, false]);
    assert.equal(M.sinkBadge(cleared[0]), "Display");
    // The cached rows are not mutated.
    assert.equal(cached[0].active, true);
  });

  it("marks the live session peer case-insensitively", () => {
    const cached = M.parseStatus(NMCLI_SCAN).sinks;
    const marked = M.refreshSinkActives(cached, "9a:03:cf:fc:40:a3");
    assert.deepEqual(marked.map((s) => s.active), [true, false, false]);
    assert.equal(M.sinkBadge(marked[0]), "Connected");
  });

  it("tolerates empty or ragged sink caches", () => {
    assert.deepEqual(M.refreshSinkActives([], "AA:BB:CC:DD:EE:FF"), []);
    assert.deepEqual(M.refreshSinkActives(null, ""), []);
    assert.deepEqual(M.refreshSinkActives([null, {}], ""), [
      { name: "(unknown)", hw: "", wfd: false, active: false },
      { name: "(unknown)", hw: "", wfd: false, active: false }
    ]);
  });
});

describe("scan parser", () => {
  // Live `fluxcast --wfd-scan` capture (FluxCast 0.2.9): two plain
  // devices, one WFD sink, one unnamed peer. The awk program under test
  // is extracted from probe.sh itself, so this pins the shipped parser.
  const SCAN_FIXTURE =
    "[FluxCast] Version: 0.2.9-0-gdc200ee (branch: main)\n" +
    "[FluxCast WFD] Starting NetworkManager Wi-Fi Direct scan on p2p-dev-wlp0s20f3 for 10s...\n" +
    "[FluxCast WFD] Wi-Fi Direct peer(s):\n" +
    "  [0] C6:95:00:71:95:A3  Emilias 2. Fire TV Stick via NetworkManager\n" +
    "      not advertising Wi-Fi Display; if this is a TV, put it into Screen Share mode first\n" +
    "      already running its own group; FluxCast can start a new one but cannot join an existing group\n" +
    "  [1] 5E:60:BA:69:69:2D  DIRECT-2D-HP DeskJet 2800 series via NetworkManager\n" +
    "      not advertising Wi-Fi Display; if this is a TV, put it into Screen Share mode first\n" +
    "      already running its own group; FluxCast can start a new one but cannot join an existing group\n" +
    "  [2] 9A:03:CF:FC:40:A3  U0320 via NetworkManager\n" +
    "      WFD capability data detected\n" +
    "  [3] AA:BB:CC:DD:EE:FF via NetworkManager\n" +
    "      not advertising Wi-Fi Display; if this is a TV, put it into Screen Share mode first\n";

  function probeAwk() {
    const src = fs.readFileSync(path.join(__dirname, "probe.sh"), "utf8");
    const begin = src.indexOf("#SINK_AWK_BEGIN");
    const end = src.indexOf("#SINK_AWK_END");
    assert.ok(begin !== -1 && end !== -1 && begin < end, "sink awk markers present in probe.sh");
    return src.slice(begin, end) + "#SINK_AWK_END\n";
  }

  function runScan(fixture, sessionMac) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screencast-scan-"));
    const prog = path.join(dir, "sink.awk");
    fs.writeFileSync(prog, probeAwk());
    try {
      return execFileSync("awk", ["-v", "session_mac=" + sessionMac, "-f", prog], {
        input: fixture, encoding: "utf8"
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("parses a live fluxcast scan into sink lines", () => {
    assert.equal(
      runScan(SCAN_FIXTURE, ""),
      "sink=Emilias 2. Fire TV Stick\tC6:95:00:71:95:A3\t0\t0\n" +
      "sink=DIRECT-2D-HP DeskJet 2800 series\t5E:60:BA:69:69:2D\t0\t0\n" +
      "sink=U0320\t9A:03:CF:FC:40:A3\t1\t0\n" +
      "sink=\tAA:BB:CC:DD:EE:FF\t0\t0\n"
    );
  });

  it("marks the session peer active case-insensitively", () => {
    const out = runScan(SCAN_FIXTURE, "9a:03:cf:fc:40:a3");
    assert.ok(out.indexOf("sink=U0320\t9A:03:CF:FC:40:A3\t1\t1\n") !== -1);
  });

  it("emits nothing without peers", () => {
    assert.equal(runScan("[FluxCast WFD] No Wi-Fi Direct peers found.\n", ""), "");
  });
});

describe("known displays", () => {
  it("parses history entries and skips empty MACs", () => {
    const s = M.parseStatus(NMCLI_SCAN);
    assert.deepEqual(s.knownRaw, [
      { mac: "9A:03:CF:FC:40:A3", epoch: 1792223068, name: "U0320" },
      { mac: "C0:FF:EE:00:11:22", epoch: 1791000000, name: "Old Projector" }
    ]);
    assert.deepEqual(M.parseKnown(""), null);
    assert.deepEqual(M.parseKnown("\t123\t\t"), null);
  });

  it("merges known with nearby without duplicates", () => {
    const s = M.parseStatus(NMCLI_SCAN);
    const rows = M.knownRows(s.sinks, s.knownRaw, "", NOW);
    assert.deepEqual(rows.map((r) => r.label), ["Old Projector"]);
  });

  it("passes MAC and raw name through for direct connect", () => {
    const s = M.parseStatus(NMCLI_SCAN);
    const rows = M.knownRows(s.sinks, s.knownRaw, "", NOW);
    assert.deepEqual(rows.map((r) => [r.mac, r.name]), [["C0:FF:EE:00:11:22", "Old Projector"]]);
  });

  it("dedupes by MAC keeping the newest entry", () => {
    const known = [
      { mac: "AA:BB:CC:DD:EE:FF", epoch: 100, name: "Old" },
      { mac: "aa:bb:cc:dd:ee:ff", epoch: 200, name: "New" }
    ];
    const rows = M.knownRows([], known, "", NOW);
    assert.deepEqual(rows.map((r) => r.label), ["New"]);
  });

  it("sorts by recency and labels name over MAC", () => {
    const known = [
      { mac: "11:11:11:11:11:11", epoch: 100, name: "" },
      { mac: "22:22:22:22:22:22", epoch: 300, name: "Named" },
      { mac: "33:33:33:33:33:33", epoch: 200, name: "Other" }
    ];
    const rows = M.knownRows([], known, "", NOW);
    assert.deepEqual(rows.map((r) => r.label), ["Named", "Other", "11:11:11:11:11:11"]);
  });

  it("marks the active session peer as connected", () => {
    const known = [{ mac: "9A:03:CF:FC:40:A3", epoch: 1792223000, name: "U0320" }];
    const rows = M.knownRows([], known, "9a:03:cf:fc:40:a3", NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].badge, "Connected");
    assert.equal(rows[0].active, true);
  });

  it("badges recency and unknown times", () => {
    const known = [
      { mac: "AA:AA:AA:AA:AA:AA", epoch: NOW - 30, name: "A" },
      { mac: "BB:BB:BB:BB:BB:BB", epoch: 0, name: "B" }
    ];
    const rows = M.knownRows([], known, "", NOW);
    assert.equal(rows[0].badge, "just now");
    assert.equal(rows[1].badge, "Known");
  });

  it("formats relative times", () => {
    assert.equal(M.relTime(100, 100), "just now");
    assert.equal(M.relTime(100, 100 + 30), "just now");
    assert.equal(M.relTime(100, 100 + 300), "5m ago");
    assert.equal(M.relTime(100, 100 + 3 * 3600), "3h ago");
    assert.equal(M.relTime(100, 100 + 2 * 86400), "2d ago");
    assert.equal(M.relTime(200, 100), "just now");
  });

  it("extracts and validates the session MAC", () => {
    assert.equal(M.sessionMac({ peerMac: "", peer: "Wi-Fi P2P Peer 9A:03:CF:FC:40:A3" }), "9A:03:CF:FC:40:A3");
    assert.equal(M.sessionMac({ peer: "" }), "");
    assert.equal(M.sessionMac(null), "");
    assert.equal(M.isMacAddress("9A:03:CF:FC:40:A3"), true);
    assert.equal(M.isMacAddress("9a:03:cf:fc:40:a3"), true);
    assert.equal(M.isMacAddress("not-a-mac"), false);
    assert.equal(M.isMacAddress(""), false);
  });

  it("shell-quotes history names", () => {
    assert.equal(M.shQuote("Beamer"), "'Beamer'");
    assert.equal(M.shQuote("Emilia's TV"), "'Emilia'\\''s TV'");
  });

  it("accepts MAC and name peer selectors, rejects the rest", () => {
    assert.equal(M.isPeerSelector("9A:03:CF:FC:40:A3"), true);
    assert.equal(M.isPeerSelector("9a:03:cf:fc:40:a3"), true);
    assert.equal(M.isPeerSelector("  U0320  "), true);
    assert.equal(M.isPeerSelector("Emilias TV"), true);
    assert.equal(M.isPeerSelector(""), false);
    assert.equal(M.isPeerSelector(null), false);
    assert.equal(M.isPeerSelector(undefined), false);
    assert.equal(M.isPeerSelector("0"), false);
    assert.equal(M.isPeerSelector("12"), false);
    assert.equal(M.isPeerSelector("x".repeat(65)), false);
    assert.equal(M.isPeerSelector("a\nb"), false);
    assert.equal(M.isPeerSelector("a\tb"), false);
    assert.equal(M.isPeerSelector("-x"), false);
    assert.equal(M.isPeerSelector("--wfd-timeout"), false);
  });

  it("resolves scripted peers to exact MACs", () => {
    const sinks = M.parseStatus(NMCLI_SCAN).sinks;
    assert.deepEqual(M.resolvePeer(sinks, "9a:03:cf:fc:40:a3"),
      { mac: "9a:03:cf:fc:40:a3", name: "U0320" });
    assert.deepEqual(M.resolvePeer(sinks, "11:22:33:44:55:66"),
      { mac: "11:22:33:44:55:66", name: "" });
    assert.deepEqual(M.resolvePeer(sinks, "u0320"),
      { mac: "9A:03:CF:FC:40:A3", name: "U0320" });
    assert.deepEqual(M.resolvePeer(sinks, "No Such Display"), { error: "unknown peer" });
    assert.deepEqual(M.resolvePeer([], "U0320"), { error: "unknown peer" });
    assert.deepEqual(M.resolvePeer(null, "U0320"), { error: "unknown peer" });
    const dupes = [
      { name: "Twin", hw: "AA:AA:AA:AA:AA:AA", wfd: true, active: false },
      { name: "twin", hw: "BB:BB:BB:BB:BB:BB", wfd: true, active: false }
    ];
    assert.deepEqual(M.resolvePeer(dupes, "TWIN"), { error: "ambiguous peer" });
    const ragged = [null, {}, { name: "U0320" }, { name: "U0320", hw: "not-a-mac" }];
    assert.deepEqual(M.resolvePeer(ragged, "U0320"), { error: "unknown peer" });
  });

  it("cycles activity dots across timer frames", () => {
    assert.equal(M.dots(0), ".");
    assert.equal(M.dots(1), "..");
    assert.equal(M.dots(2), "...");
    assert.equal(M.dots(3), ".");
    assert.equal(M.dots(null), ".");
    assert.equal(M.dots(-1), "...");
  });
});

describe("engine commands", () => {
  it("builds a windowless fluxcast connect command", () => {
    const cmd = M.connectCommand("9A:03:CF:FC:40:A3");
    assert.equal(cmd[0], "sh");
    assert.equal(cmd[1], "-c");
    assert.match(cmd[2], /fluxcast --protocol wfd/);
    assert.ok(cmd[2].indexOf("--wfd-peer '9A:03:CF:FC:40:A3'") !== -1);
    assert.match(cmd[2], /--wfd-timeout 4/);
    assert.match(cmd[2], /--monitor/);
    assert.match(cmd[2], /xrandr --query/);
    assert.match(cmd[2], /\/tmp\/\.X\[0-9\]\*-lock/);
    assert.match(cmd[2], /\$2=="connected"&&\$3=="primary"/);
    assert.match(cmd[2], /<\/dev\/null/);
  });

  it("tees engine output to a trimmed log for post-mortems", () => {
    const cmd = M.connectCommand("9A:03:CF:FC:40:A3");
    assert.match(cmd[2], /fluxcast\.log/);
    assert.match(cmd[2], /tee -a/);
    assert.match(cmd[2], /tail -n 200/);
    // Python block-buffers piped stdout: FluxCast's own lines are lost
    // when the engine is signalled unless output is unbuffered.
    assert.match(cmd[2], /PYTHONUNBUFFERED=1 fluxcast /);
    // Each run opens with an epoch marker the probe splits runs on, written
    // after the trim so the latest run is always whole.
    const marker = cmd[2].indexOf("=== kili.screencast run %s ===");
    assert.ok(marker > cmd[2].indexOf("tail -n 200"), "marker after trim");
    assert.ok(marker < cmd[2].indexOf("fluxcast --protocol"), "marker before engine");
    assert.match(cmd[2], /"\$\(date \+%s\)"/);
  });

  it("writes a run marker the probe recognizes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screencast-marker-"));
    try {
      // Run only the log setup: HOME redirected, engine stubbed out.
      const script = M.connectCommand("9A:03:CF:FC:40:A3")[2]
        .replace(/mon=\$\(.*$/, "true");
      execFileSync("sh", ["-c", script], { env: { ...process.env, HOME: dir } });
      const log = fs.readFileSync(path.join(dir, ".local/state/kili.screencast/fluxcast.log"), "utf8");
      assert.match(log, /^=== kili\.screencast run \d{10} ===\n$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quotes a hostile peer selector safely", () => {
    const evil = "x'; touch /tmp/pwned; echo '";
    const cmd = M.connectCommand(evil);
    assert.ok(cmd[2].indexOf(M.shQuote(evil)) !== -1);
    assert.ok(cmd[2].indexOf(evil) === -1);
  });

  it("disconnects the engine gently before dropping the link", () => {
    const cmd = M.disconnectCommand();
    assert.equal(cmd[0], "sh");
    assert.equal(cmd[1], "-c");
    assert.match(cmd[2], /pkill -INT -f 'protocol wf\[d\]'/);
    assert.ok(cmd[2].indexOf("protocol wfd") === -1);
    assert.match(cmd[2], /sleep 0\.15/);
    assert.ok(cmd[2].indexOf("sleep 2") === -1);
    assert.match(cmd[2], /nmcli device disconnect/);
  });
});

describe("wifi off", () => {
  const OFF = (p2pLine) =>
    "app=stopped\n" +
    (p2pLine ? p2pLine + "\n" : "") +
    "wifi=disabled\n" +
    "nm_name=\n" +
    "mdns_name=\n" +
    "peer_mac=\n" +
    "known_begin\n";

  it("names wifi as the cause with or without a p2p row", () => {
    for (const body of [OFF(""), OFF("p2p-dev-wlp0s20f3:wifi-p2p:unavailable:")]) {
      const s = M.parseStatus(body);
      assert.equal(s.wifiOn, false);
      assert.equal(M.heroStatus(s, false), "Disconnected");
      assert.equal(M.linkText(s), "Please turn on Wi-Fi to use casting");
      assert.equal(M.tooltipText(s), "Screencast needs Wi-Fi - please turn it on");
    }
    const withRow = M.parseStatus(OFF("p2p-dev-wlp0s20f3:wifi-p2p:unavailable:"));
    assert.equal(withRow.p2pDevice, "p2p-dev-wlp0s20f3");
    assert.equal(withRow.p2pState, "unavailable");
  });

  it("assumes wifi on when the probe omits the line", () => {
    assert.equal(M.parseStatus(NMCLI_IDLE).wifiOn, true);
  });
});

describe("display helpers", () => {
  it("shows Connected, Disconnected, or nothing while busy", () => {
    assert.equal(M.heroStatus(M.parseStatus(FLUXCAST_CONNECTED), false), "Connected");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_CONNECTED), false), "Waiting");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_CONNECTED), true), "");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_CONNECTING), true), "");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_ENGINE_RUNNING), false), "Disconnected");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_IDLE), false), "Disconnected");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_IDLE), true), "");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_NO_P2P), false), "Disconnected");
    assert.equal(M.heroStatus(null, false), "Disconnected");
  });

  it("reads link-without-video as Waiting, not Connected", () => {
    const s = M.parseStatus(FLUXCAST_WAITING);
    assert.equal(s.connected, true);
    assert.equal(s.video, false);
    assert.equal(M.heroStatus(s, false), "Waiting");
    assert.equal(M.heroStatus(s, true), "");
    assert.equal(
      M.tooltipText(s),
      "Screencast waiting for the display to start video"
    );
    // The link line still names the peer; the popup adds the Waiting text.
    assert.equal(M.linkText(s), "U0320");
  });

  it("parses the video flag, defaulting to no video", () => {
    assert.equal(M.parseStatus(FLUXCAST_CONNECTED).video, true);
    assert.equal(M.parseStatus(FLUXCAST_WAITING).video, false);
    assert.equal(M.parseStatus(NMCLI_IDLE).video, false);
    assert.equal(M.parseStatus(NMCLI_CONNECTED).video, false);
  });

  it("prefers P2P name, then mDNS, then raw peer", () => {
    assert.equal(M.peerLabel(M.parseStatus(NMCLI_CONNECTED_NAMED)), "U0320");
    assert.equal(M.peerLabel(M.parseStatus(NMCLI_CONNECTED_MDNS_ONLY)), "Android");
    assert.equal(
      M.peerLabel(M.parseStatus(NMCLI_CONNECTED)),
      "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF"
    );
    assert.equal(M.peerLabel(M.parseStatus(NMCLI_IDLE)), "");
  });

  it("names the peer in the connected tooltip", () => {
    assert.equal(
      M.tooltipText(M.parseStatus(FLUXCAST_CONNECTED)),
      "Screencast: U0320"
    );
    assert.equal(
      M.tooltipText(M.parseStatus(NMCLI_CONNECTING)),
      "Screencast connecting..."
    );
  });

  it("names waiting instead of a peer without video", () => {
    assert.equal(
      M.tooltipText(M.parseStatus(NMCLI_CONNECTED_NAMED)),
      "Screencast waiting for the display to start video"
    );
    assert.equal(
      M.tooltipText(M.parseStatus(NMCLI_CONNECTED)),
      "Screencast waiting for the display to start video"
    );
  });

  it("names the running engine without a link", () => {
    assert.equal(
      M.tooltipText(M.parseStatus(NMCLI_ENGINE_RUNNING)),
      "Screencast engine running - not connected"
    );
  });

  it("describes the link line for each state", () => {
    assert.equal(M.linkText(M.parseStatus(NMCLI_CONNECTED_NAMED)), "U0320");
    assert.equal(M.linkText(M.parseStatus(NMCLI_CONNECTED_MDNS_ONLY)), "Android");
    assert.equal(
      M.linkText(M.parseStatus(NMCLI_CONNECTED)),
      "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF"
    );
    assert.equal(
      M.linkText(M.parseStatus(NMCLI_CONNECTING)),
      "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF"
    );
    assert.equal(M.linkText(M.parseStatus(NMCLI_IDLE)), "");
    assert.equal(M.linkText(M.parseStatus(NMCLI_UNAVAILABLE)), "");
    assert.equal(M.linkText(M.parseStatus(NMCLI_NO_P2P)), "");
  });

  it("reaps only a linkless engine past the grace period", () => {
    assert.equal(M.LINKLESS_REAP_MS, 90000);
    assert.equal(M.shouldReapLinkless(0), false);
    assert.equal(M.shouldReapLinkless(89999), false);
    assert.equal(M.shouldReapLinkless(90000), true);
    assert.equal(M.shouldReapLinkless(300000), true);
    assert.equal(M.shouldReapLinkless(undefined), false);
  });

  it("paces recovery: delayed retry, patient waiting threshold", () => {
    assert.equal(M.RECOVERY_DELAY_MS, 10000);
    assert.equal(M.WAITING_VIDEO_MS, 60000);
    assert.equal(M.shouldRecoverWaiting(0), false);
    assert.equal(M.shouldRecoverWaiting(59999), false);
    assert.equal(M.shouldRecoverWaiting(60000), true);
    assert.equal(M.shouldRecoverWaiting(600000), true);
    assert.equal(M.shouldRecoverWaiting(undefined), false);
  });

  it("pins the verified Nerd Font codepoints", () => {
    assert.equal(M.ICON_IDLE.codePointAt(0), 0xF0118);
    assert.equal(M.ICON_CONNECTED.codePointAt(0), 0xF0119);
    assert.equal(M.iconFor(M.parseStatus(NMCLI_CONNECTED)), M.ICON_CONNECTED);
    assert.equal(M.iconFor(M.parseStatus(NMCLI_IDLE)), M.ICON_IDLE);
  });
});

describe("error messages", () => {
  // Live FluxCast 0.2.9 run against the U0320 (fluxcast.run1.log, after
  // the firewall fix): a healthy session through PLAY.
  const HEALTHY_RUN = [
    "[FluxCast WFD] P2P link is activated; waiting for RTSP session...",
    "[FluxCast WFD] ufw is enabled. If the sink never opens its RTSP connection, allow the port FluxCast listens on:",
    "    sudo ufw allow 7236/tcp    # RTSP",
    "[FluxCast WFD] Waiting for TV RTSP/WFD session. Press Ctrl+C to stop.",
    "[FluxCast WFD RTSP] TV connected from 192.168.49.1:57648; local=192.168.49.224",
    "[FluxCast WFD RTSP] -> M1_OPTIONS: OPTIONS (CSeq 1)",
    "[FluxCast WFD RTSP] <- request: PLAY rtsp://192.168.49.224/wfd1.0/streamid=0 RTSP/1.0",
    "[FluxCast WFD RTSP] -> response 200 OK for PLAY",
    "[FluxCast WFD RTSP] PLAY accepted; media stream started.",
    "[FluxCast WFD Media] Sender health: pid=229735:running, pid=229736:running; tx+851 KiB on p2p-wlp0s20-4"
  ];

  // Live widget run where the sink left its group 1.5 s after the link
  // came up (pre-unbuffer, so only ffmpeg's stderr survived).
  const DROPPED_RUN = [
    "[aost#0:1/aac @ 0x5fe9db7fb440] Error submitting a packet to the muxer: Network is unreachable",
    "[out#0/rtp_mpegts @ 0x5fe9db7f8c40] Error muxing a packet",
    "[udp @ 0x63d86fdf4680] bind failed: Cannot assign requested address",
    "Error opening output files: Cannot assign requested address"
  ];

  // FluxCast's own failure strings (wfd/ sources, 0.2.9).
  const ERR = (msg) => "[FluxCast WFD] ERROR: " + msg;

  it("finds no failure in a healthy run or an empty one", () => {
    assert.equal(M.engineFailure(HEALTHY_RUN), null);
    assert.equal(M.engineFailure([]), null);
    assert.equal(M.engineFailure(undefined), null);
  });

  it("names each FluxCast failure by its root cause", () => {
    const cases = [
      [[ERR("No Wi-Fi Direct peers found. Put the TV into Screen Share/Wireless Display mode.")], "not-found"],
      [[ERR("No peer matched selector: 00:11:22:33:44:55")], "not-found"],
      [[ERR("Timed out waiting for NetworkManager Wi-Fi Direct activation. Last status: activating")], "link-failed"],
      [[ERR("NetworkManager deactivated the Wi-Fi Direct connection before RTSP. Last status: x")], "link-failed"],
      [[ERR("NetworkManager activated the Wi-Fi Direct connection, but its P2P group interface could not be determined.")], "link-failed"],
      [[ERR("Monitor 'HDMI-A-1' not found. Available: eDP-1")], "no-monitor"],
      [[ERR("Miracast/WFD is not ready on this machine yet. Fix the warn/fail rows above, then run --wfd-scan.")], "not-ready"],
      [[ERR("NetworkManager did not expose a Wi-Fi P2P device before scanning.")], "no-p2p"],
      [["Traceback (most recent call last):", '  File "/opt/fluxcast/wfd/rtsp/rtsp_server.py", line 210, in start',
        "OSError: [Errno 98] Address already in use"], "port-busy"],
      [["[FluxCast WFD RTSP] ERROR: wf-recorder exited immediately during WFD streaming."], "media-failed"],
      [DROPPED_RUN, "lost"]
    ];
    for (const [lines, code] of cases) {
      assert.equal(M.engineFailure(lines).code, code, lines[lines.length - 1]);
    }
  });

  it("tells an aborted setup from a session the sink ended", () => {
    const setup = M.engineFailure([
      "[FluxCast WFD RTSP] TV connected from 192.168.49.1:57648; local=192.168.49.224",
      "[FluxCast WFD RTSP] ERROR: RTSP M4_SET_PARAMETER failed: RTSP/1.0 400 Bad Request"
    ]);
    assert.deepEqual(setup, { code: "rtsp-failed", detail: "RTSP M4_SET_PARAMETER failed: RTSP/1.0 400 Bad Request" });
    assert.equal(M.engineFailure(["[FluxCast WFD RTSP] Socket closed: RTSP read timed out"]).code, "rtsp-failed");
    const ended = HEALTHY_RUN.concat(["[FluxCast WFD RTSP] <- request: TEARDOWN rtsp://192.168.49.224/wfd1.0/streamid=0 RTSP/1.0"]);
    assert.equal(M.engineFailure(ended).code, "sink-ended");
  });

  it("passes unknown FluxCast errors and crashes through in its own words", () => {
    assert.deepEqual(M.engineFailure([ERR("Something new went wrong")]), { code: "engine-error", detail: "Something new went wrong" });
    assert.deepEqual(
      M.engineFailure(["Traceback (most recent call last):", '  File "x.py", line 1', "ValueError: boom"]),
      { code: "crashed", detail: "ValueError: boom" }
    );
    // SIGINT before the session loop is our own teardown, not a crash.
    assert.equal(M.engineFailure(["Traceback (most recent call last):", '  File "x.py", line 1', "KeyboardInterrupt"]), null);
  });

  it("parses failure evidence from the probe", () => {
    const s = M.parseStatus(
      FLUXCAST_WAITING +
      "engine_bin=yes\nfw_block=3\nlog_run=1792347896\n" +
      "log=" + ERR("No peer matched selector: x") + "\nlog=app=running\n"
    );
    assert.equal(s.probed, true);
    assert.equal(s.engineInstalled, true);
    assert.equal(s.fwBlocked, true);
    assert.equal(s.portBusy, false);
    assert.equal(s.logRun, 1792347896);
    // Log payloads never leak into other fields, even when they look like probe lines.
    assert.deepEqual(s.logLines, [ERR("No peer matched selector: x"), "app=running"]);
    assert.equal(s.appRunning, true);
    const idle = M.parseStatus(NMCLI_IDLE + "engine_bin=no\nrtsp_port=busy\nfw_block=0\n");
    assert.equal(idle.engineInstalled, false);
    assert.equal(idle.portBusy, true);
    assert.equal(idle.fwBlocked, false);
    assert.equal(M.emptyStatus().probed, false);
  });

  it("diagnoses from this attempt's log, then the firewall, then the fallback", () => {
    const withLog = (run, extra) => M.parseStatus(
      FLUXCAST_WAITING + (extra || "") + "log_run=" + run + "\nlog=" + ERR("No peer matched selector: x") + "\n"
    );
    assert.equal(M.diagnose(withLog(1000), 1000, "link-failed").code, "not-found");
    // A run older than the attempt is an earlier attempt's story.
    assert.equal(M.diagnose(withLog(999), 1000, "link-failed").code, "link-failed");
    // 0 = foreign engine: its output is not in our log.
    assert.equal(M.diagnose(withLog(1000), 0, "link-failed").code, "link-failed");
    assert.equal(M.diagnose(withLog(999, "fw_block=2\n"), 1000, "no-video").code, "firewall");
    assert.equal(M.diagnose(M.parseStatus(FLUXCAST_WAITING), 1000, "").code, "engine-exit");
    assert.equal(M.diagnose(null, 0, "no-video").code, "no-video");
  });

  it("refines a drop after video only by a sink teardown", () => {
    const run = (lines) => M.parseStatus("app=running\nlog_run=1000\n" + lines.map((l) => "log=" + l + "\n").join(""));
    assert.equal(M.diagnose(run(DROPPED_RUN), 1000, "lost").code, "lost");
    assert.equal(M.diagnose(run(["[FluxCast WFD RTSP] TV disconnected from 192.168.49.1:57648"]), 1000, "lost").code, "sink-ended");
  });

  it("says what failed and what to do, naming the display", () => {
    assert.equal(M.errorMessage("", "U0320", ""), "");
    assert.equal(
      M.errorMessage("firewall", "U0320", ""),
      "Firewall is blocking U0320 on TCP 7236. Run: sudo ufw allow 7236/tcp && sudo ufw reload"
    );
    assert.equal(M.errorMessage("not-found", "U0320", ""), "U0320 was not found. Is it on and in screen-mirroring mode?");
    assert.equal(M.errorMessage("not-found", "", ""), "The display was not found. Is it on and in screen-mirroring mode?");
    assert.equal(M.errorMessage("lost", "", ""), "Lost the connection to the display.");
    assert.equal(
      M.errorMessage("rtsp-failed", "U0320", "RTSP M4_SET_PARAMETER failed: RTSP/1.0 400 Bad Request."),
      "U0320 broke off the video session setup (RTSP M4_SET_PARAMETER failed: RTSP/1.0 400 Bad Request)."
    );
    assert.equal(M.errorMessage("engine-error", "", "Something new"), "FluxCast: Something new");
    assert.equal(M.errorMessage("not-installed", "", ""), "FluxCast is not installed. Run: omarchy pkg aur add fluxcast-git");
    assert.match(M.errorMessage("no-such-code", "", ""), /^Screencast failed\. See ~\/\.local\/state\/kili\.screencast\/fluxcast\.log$/);
    // Every code the widget can produce has its own text.
    const codes = ["firewall", "no-video", "not-found", "link-failed", "rtsp-failed", "sink-ended", "lost",
      "media-failed", "no-monitor", "port-busy", "not-ready", "no-p2p", "not-installed", "crashed",
      "engine-error", "engine-exit"];
    for (const code of codes) {
      assert.doesNotMatch(M.errorMessage(code, "U0320", ""), /^Screencast failed/, code);
    }
  });

  it("keeps FluxCast's words to one clean, bounded line", () => {
    assert.equal(M.cleanDetail("a\x1b[31m\r\nb\t c "), "a [31m b c");
    const long = M.cleanDetail("x".repeat(500));
    assert.equal(long.length, 160);
    assert.ok(long.endsWith("…"));
    assert.equal(M.cleanDetail(null), "");
  });

  it("refuses a click only for steady local problems", () => {
    assert.equal(M.steadyError(M.emptyStatus()), "", "unprobed status is not an error");
    assert.equal(M.steadyError(M.parseStatus(NMCLI_IDLE)), "");
    assert.equal(M.steadyError(M.parseStatus(NMCLI_IDLE + "engine_bin=no\n")), "not-installed");
    assert.equal(M.steadyError(M.parseStatus(NMCLI_IDLE + "rtsp_port=busy\n")), "port-busy");
    // Our own running engine holds the port legitimately.
    assert.equal(M.steadyError(M.parseStatus(FLUXCAST_WAITING + "rtsp_port=busy\n")), "");
    assert.equal(M.steadyError(M.parseStatus(NMCLI_NO_P2P)), "no-p2p");
  });

  it("retries the sink's failures, never local setup problems", () => {
    for (const code of ["not-found", "link-failed", "engine-exit", "rtsp-failed", "no-video", "lost"]) {
      assert.equal(M.shouldRetry(code), true, code);
    }
    for (const code of ["port-busy", "no-monitor", "not-ready", "no-p2p", "not-installed"]) {
      assert.equal(M.shouldRetry(code), false, code);
    }
  });

  it("shows the error in the tooltip once idle or while video waits", () => {
    const err = "Firewall is blocking U0320 on TCP 7236.";
    assert.equal(M.tooltipText(M.parseStatus(FLUXCAST_WAITING), err), "Screencast: " + err);
    assert.equal(M.tooltipText(M.parseStatus(NMCLI_IDLE), err), "Screencast: " + err);
    assert.equal(M.tooltipText(M.parseStatus(FLUXCAST_CONNECTED), err), "Screencast: U0320");
    assert.equal(M.tooltipText(M.parseStatus(NMCLI_IDLE), ""), "Screencast idle");
  });
});

describe("engine log probe", () => {
  // The awk program is extracted from probe.sh itself, like the scan parser.
  function logAwk() {
    const src = fs.readFileSync(path.join(__dirname, "probe.sh"), "utf8");
    const begin = src.indexOf("#LOG_AWK_BEGIN");
    const end = src.indexOf("#LOG_AWK_END");
    assert.ok(begin !== -1 && end !== -1 && begin < end, "log awk markers present in probe.sh");
    return src.slice(begin, end) + "#LOG_AWK_END\n";
  }

  function runLog(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screencast-log-"));
    const prog = path.join(dir, "log.awk");
    fs.writeFileSync(prog, logAwk());
    try {
      return execFileSync("awk", ["-f", prog], { input: content, encoding: "utf8" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("emits only the latest run, tagged with its epoch", () => {
    const out = runLog(
      "=== kili.screencast run 1000 ===\nold line\n" +
      "=== kili.screencast run 2000 ===\nnew one\nnew two\n"
    );
    assert.equal(out, "log_run=2000\nlog=new one\nlog=new two\n");
  });

  it("caps a long run at its last 60 lines", () => {
    let content = "=== kili.screencast run 3000 ===\n";
    for (let i = 1; i <= 75; i++) content += "line " + i + "\n";
    const lines = runLog(content).trimEnd().split("\n");
    assert.equal(lines.length, 61);
    assert.equal(lines[1], "log=line 16");
    assert.equal(lines[60], "log=line 75");
  });

  it("emits nothing for a log without markers", () => {
    assert.equal(runLog("pre-marker output\n"), "");
    assert.equal(runLog(""), "");
  });
});
