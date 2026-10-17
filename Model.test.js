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
      wifiOn: true,
      sinks: [],
      hasSinks: false,
      knownRaw: [
        { mac: "9A:03:CF:FC:40:A3", epoch: 1792223000, name: "U0320" }
      ]
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
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_CONNECTED), false), "Connected");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_CONNECTED), true), "");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_CONNECTING), true), "");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_ENGINE_RUNNING), false), "Disconnected");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_IDLE), false), "Disconnected");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_IDLE), true), "");
    assert.equal(M.heroStatus(M.parseStatus(NMCLI_NO_P2P), false), "Disconnected");
    assert.equal(M.heroStatus(null, false), "Disconnected");
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
      M.tooltipText(M.parseStatus(NMCLI_CONNECTED_NAMED)),
      "Screencast: U0320"
    );
    assert.equal(
      M.tooltipText(M.parseStatus(NMCLI_CONNECTED)),
      "Screencast: Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF"
    );
    assert.equal(
      M.tooltipText(M.parseStatus(NMCLI_CONNECTING)),
      "Screencast connecting..."
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

  it("pins the verified Nerd Font codepoints", () => {
    assert.equal(M.ICON_IDLE.codePointAt(0), 0xF0118);
    assert.equal(M.ICON_CONNECTED.codePointAt(0), 0xF0119);
    assert.equal(M.iconFor(M.parseStatus(NMCLI_CONNECTED)), M.ICON_CONNECTED);
    assert.equal(M.iconFor(M.parseStatus(NMCLI_IDLE)), M.ICON_IDLE);
  });
});
