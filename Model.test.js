const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const M = require("./Model.js");

// Grounded in live `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`
// output (peer MAC anonymized). Terse mode backslash-escapes the colons.
const NMCLI_CONNECTED =
  "app=running\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "tailscale0:tun:connected (externally):tailscale0\n" +
  "lo:loopback:connected (externally):lo\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "known_begin\n" +
  "known=9A:03:CF:FC:40:A3\t1792223000\tBeamer\tU0320\n";

const NMCLI_CONNECTED_NAMED =
  "app=running\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "alias_name=Beamer\n" +
  "nm_name=U0320\n" +
  "mdns_name=Android\n" +
  "known_begin\n";

const NMCLI_CONNECTED_NM_ONLY =
  "app=running\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "alias_name=\n" +
  "nm_name=U0320\n" +
  "mdns_name=Android\n" +
  "known_begin\n";

const NMCLI_CONNECTED_MDNS_ONLY =
  "app=running\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connected:Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=Android\n" +
  "known_begin\n";

const NMCLI_CONNECTING =
  "app=running\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:connecting (configuring):Wi-Fi P2P Peer AA\\:BB\\:CC\\:DD\\:EE\\:FF\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "known_begin\n";

const NMCLI_IDLE =
  "app=stopped\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "known_begin\n" +
  "known=9A:03:CF:FC:40:A3\t1792223000\tBeamer\tU0320\n";

const NMCLI_UNAVAILABLE =
  "app=stopped\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:unavailable:\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "known_begin\n";

const NMCLI_PICKER_OPEN =
  "app=running\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "known_begin\n";

const NMCLI_NO_P2P =
  "app=stopped\n" +
  "wlp0s20f3:wifi:connected:Ludalan&DaniDauerlan\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "known_begin\n";

// Scan-mode output: fast block plus sink and known sections. The beamer is
// both nearby and known, so the merge must show it exactly once (nearby).
const NMCLI_SCAN =
  "app=stopped\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
  "known_begin\n" +
  "known=9A:03:CF:FC:40:A3\t1792223068\tBeamer\tU0320\n" +
  "known=C0:FF:EE:00:11:22\t1791000000\t\tOld Projector\n" +
  "sink_begin\n" +
  "sink=U0320\t9A:03:CF:FC:40:A3\t1\t0\n" +
  "sink=Emilias 2. Fire TV Stick\tC6:95:00:71:95:A3\t0\t0\n" +
  "sink=B\u00fcro: TV=neu\tAA:BB:CC:DD:EE:FF\t1\t0\n";

const NMCLI_SCAN_EMPTY =
  "app=stopped\n" +
  "p2p-dev-wlp0s20f3:wifi-p2p:disconnected:\n" +
  "alias_name=\n" +
  "nm_name=\n" +
  "mdns_name=\n" +
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
      aliasName: "",
      nmName: "",
      mdnsName: "",
      connected: true,
      connecting: false,
      sinks: [],
      hasSinks: false,
      knownRaw: [
        { mac: "9A:03:CF:FC:40:A3", epoch: 1792223000, alias: "Beamer", name: "U0320" }
      ]
    });
  });

  it("reads all three name tiers", () => {
    const s = M.parseStatus(NMCLI_CONNECTED_NAMED);
    assert.equal(s.aliasName, "Beamer");
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

  it("sees the open picker without a link", () => {
    const s = M.parseStatus(NMCLI_PICKER_OPEN);
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
});

describe("known displays", () => {
  it("parses history entries and skips empty MACs", () => {
    const s = M.parseStatus(NMCLI_SCAN);
    assert.deepEqual(s.knownRaw, [
      { mac: "9A:03:CF:FC:40:A3", epoch: 1792223068, alias: "Beamer", name: "U0320" },
      { mac: "C0:FF:EE:00:11:22", epoch: 1791000000, alias: "", name: "Old Projector" }
    ]);
    assert.deepEqual(M.parseKnown(""), null);
    assert.deepEqual(M.parseKnown("\t123\t\t"), null);
  });

  it("merges known with nearby without duplicates", () => {
    const s = M.parseStatus(NMCLI_SCAN);
    const rows = M.knownRows(s.sinks, s.knownRaw, "", NOW);
    assert.deepEqual(rows.map((r) => r.label), ["Old Projector"]);
  });

  it("dedupes by MAC keeping the newest entry", () => {
    const known = [
      { mac: "AA:BB:CC:DD:EE:FF", epoch: 100, alias: "", name: "Old" },
      { mac: "aa:bb:cc:dd:ee:ff", epoch: 200, alias: "New", name: "New" }
    ];
    const rows = M.knownRows([], known, "", NOW);
    assert.deepEqual(rows.map((r) => r.label), ["New"]);
  });

  it("sorts by recency and labels alias over name over MAC", () => {
    const known = [
      { mac: "11:11:11:11:11:11", epoch: 100, alias: "", name: "" },
      { mac: "22:22:22:22:22:22", epoch: 300, alias: "", name: "Named" },
      { mac: "33:33:33:33:33:33", epoch: 200, alias: "Aliased", name: "Other" }
    ];
    const rows = M.knownRows([], known, "", NOW);
    assert.deepEqual(rows.map((r) => r.label), ["Named", "Aliased", "11:11:11:11:11:11"]);
  });

  it("marks the active session peer as connected", () => {
    const known = [{ mac: "9A:03:CF:FC:40:A3", epoch: 1792223000, alias: "Beamer", name: "U0320" }];
    const rows = M.knownRows([], known, "9a:03:cf:fc:40:a3", NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].badge, "Connected");
    assert.equal(rows[0].active, true);
  });

  it("badges recency and unknown times", () => {
    const known = [
      { mac: "AA:AA:AA:AA:AA:AA", epoch: NOW - 30, alias: "", name: "A" },
      { mac: "BB:BB:BB:BB:BB:BB", epoch: 0, alias: "", name: "B" }
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
    assert.equal(M.sessionMac({ peer: "Wi-Fi P2P Peer 9A:03:CF:FC:40:A3" }), "9A:03:CF:FC:40:A3");
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
});

describe("display helpers", () => {
  it("labels each state", () => {
    assert.equal(M.statusText(M.parseStatus(NMCLI_CONNECTED)), "Connected");
    assert.equal(M.statusText(M.parseStatus(NMCLI_CONNECTING)), "Connecting...");
    assert.equal(M.statusText(M.parseStatus(NMCLI_PICKER_OPEN)), "Picker open");
    assert.equal(M.statusText(M.parseStatus(NMCLI_IDLE)), "Idle");
    assert.equal(M.statusText(M.parseStatus(NMCLI_NO_P2P)), "No P2P device");
  });

  it("prefers alias, then P2P name, then mDNS, then raw peer", () => {
    assert.equal(M.peerLabel(M.parseStatus(NMCLI_CONNECTED_NAMED)), "Beamer");
    assert.equal(M.peerLabel(M.parseStatus(NMCLI_CONNECTED_NM_ONLY)), "U0320");
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
      "Miracast: Beamer"
    );
    assert.equal(
      M.tooltipText(M.parseStatus(NMCLI_CONNECTED)),
      "Miracast: Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF"
    );
    assert.equal(
      M.tooltipText(M.parseStatus(NMCLI_CONNECTING)),
      "Miracast connecting..."
    );
  });

  it("describes the link line for each state", () => {
    assert.equal(M.linkText(M.parseStatus(NMCLI_CONNECTED_NAMED)), "Beamer");
    assert.equal(M.linkText(M.parseStatus(NMCLI_CONNECTED_NM_ONLY)), "U0320");
    assert.equal(M.linkText(M.parseStatus(NMCLI_CONNECTED_MDNS_ONLY)), "Android");
    assert.equal(
      M.linkText(M.parseStatus(NMCLI_CONNECTED)),
      "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF"
    );
    assert.equal(
      M.linkText(M.parseStatus(NMCLI_CONNECTING)),
      "Wi-Fi P2P Peer AA:BB:CC:DD:EE:FF"
    );
    assert.equal(M.linkText(M.parseStatus(NMCLI_IDLE)), "Disconnected");
    assert.equal(M.linkText(M.parseStatus(NMCLI_UNAVAILABLE)), "Unavailable");
    assert.equal(M.linkText(M.parseStatus(NMCLI_NO_P2P)), "No P2P device");
  });

  it("pins the verified Nerd Font codepoints", () => {
    assert.equal(M.ICON_IDLE.codePointAt(0), 0xF0118);
    assert.equal(M.ICON_CONNECTED.codePointAt(0), 0xF0119);
    assert.equal(M.iconFor(M.parseStatus(NMCLI_CONNECTED)), M.ICON_CONNECTED);
    assert.equal(M.iconFor(M.parseStatus(NMCLI_IDLE)), M.ICON_IDLE);
  });
});
