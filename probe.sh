#!/bin/sh
# Screencast status probe. Usage: probe.sh [fast|scan]
#
# Emits one "app=<running|stopped>" line (a FluxCast WFD session process),
# the `nmcli -t` device block, friendly peer-name tiers plus a
# "peer_mac=<mac>" line (the P2P peer, resolved from the group interface
# neighbors -- FluxCast names its NM link "FluxCast WFD" instead of
# "Wi-Fi P2P Peer <MAC>"), a "known_begin" marker plus one tab-separated
# "known=<mac>\t<epoch>\t\t<name>" line per history entry, and --
# in scan mode only -- a `fluxcast --wfd-scan` sweep with a "sink_begin"
# marker plus one tab-separated
# "sink=<name>\t<hw>\t<wfd>\t<active>" line per peer.
#
# NOTE: the pgrep pattern uses the bracket trick so the probe never
# matches its own command line: the regex needs a literal "wfd", but the
# command line only ever holds "wf[d]". Keep the unbracketed literal out
# of the pattern or the probe self-matches.
mode=${1:-fast}

HIST="$HOME/.local/state/kili.screencast/history.tsv"

if pgrep -f 'protocol wf[d]' >/dev/null 2>&1; then
  echo app=running
else
  echo app=stopped
fi

wifi_state=enabled
[ "$(nmcli radio wifi 2>/dev/null)" = disabled ] && wifi_state=disabled
echo "wifi=$wifi_state"

out=$(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status 2>/dev/null)
printf '%s\n' "$out"

# First match wins: only one P2P group exists at a time, its interface
# vanishes on teardown, and neighbours without lladdr (FAILED,
# INCOMPLETE) never match, so this is the live peer or nothing.
p2pif=$(iw dev 2>/dev/null | awk '$1=="Interface" && $2 ~ /^p2p-/{print $2; exit}')
mac=""
if [ -n "$p2pif" ]; then
  mac=$(ip neigh show dev "$p2pif" 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="lladdr" && $(i+1) ~ /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/){print $(i+1); exit}}')
fi
echo "peer_mac=$mac"

nm_name=""; mdns_name=""
if [ -n "$mac" ]; then
  mac_up=$(printf '%s' "$mac" | tr 'a-z' 'A-Z')
  for pp in $(busctl --system tree org.freedesktop.NetworkManager 2>/dev/null | grep -o "/org/freedesktop/NetworkManager/WifiP2PPeer/[0-9]*"); do
    hw=$(busctl --system get-property org.freedesktop.NetworkManager "$pp" org.freedesktop.NetworkManager.WifiP2PPeer HwAddress 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')
    hw_up=$(printf '%s' "$hw" | tr 'a-z' 'A-Z')
    if [ "$hw_up" = "$mac_up" ]; then
      nm_name=$(busctl --system get-property org.freedesktop.NetworkManager "$pp" org.freedesktop.NetworkManager.WifiP2PPeer Name 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')
      break
    fi
  done
  # mDNS only matters when no P2P name resolved (the label prefers the
  # P2P name), and its lookup can stall a full 2 s when mDNS blackholes.
  if [ -z "$nm_name" ]; then
    ip=$(ip neigh 2>/dev/null | grep -i "$mac" | head -n 1 | awk '{print $1}')
    if [ -n "$ip" ]; then
      host=$(timeout 2 avahi-resolve-address "$ip" 2>/dev/null | awk '{print $2}')
      mdns_name=${host%.local}
    fi
  fi
fi
echo "nm_name=$nm_name"
echo "mdns_name=$mdns_name"

# Video actually flowing: an established TCP session on the WFD RTSP port.
# A P2P link alone is not a cast -- the sink joins first and only starts
# video later (or never, when it missed our discovery). Nothing else on
# this machine uses 7236, so any established match is the sink talking
# to our engine.
if ss -tn state established 2>/dev/null | grep -q ':7236'; then
  echo video=yes
else
  echo video=no
fi

echo known_begin
if [ -f "$HIST" ]; then
  while IFS= read -r hline; do
    [ -z "$hline" ] && continue
    h_mac=$(printf '%s\n' "$hline" | cut -f1)
    h_epoch=$(printf '%s\n' "$hline" | cut -f2)
    h_name=$(printf '%s\n' "$hline" | cut -f3-)
    printf 'known=%s\t%s\t\t%s\n' "$h_mac" "$h_epoch" "$h_name"
  done < "$HIST"
fi

if [ "$mode" = scan ]; then
  echo sink_begin
  if [ "$wifi_state" = enabled ] && command -v fluxcast >/dev/null 2>&1; then
    fluxcast --wfd-scan --wfd-timeout 8 2>/dev/null | awk -v session_mac="$mac" '
      #SINK_AWK_BEGIN
      function emit() {
        active = 0
        if (session_mac != "" && toupper(mac) == toupper(session_mac)) active = 1
        printf "sink=%s\t%s\t%d\t%d\n", name, mac, wfd, active
      }
      $0 ~ /^  \[[0-9]+\] / && $2 ~ /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/ {
        if (mac != "") emit()
        mac = $2
        endfield = ($(NF-1) == "via") ? NF-2 : NF
        name = ""
        if (endfield >= 3) {
          name = $3
          for (i = 4; i <= endfield; i++) name = name " " $i
        }
        gsub(/\t/, " ", name)
        wfd = 0
        next
      }
      /^      WFD capability data detected/ { wfd = 1; next }
      END { if (mac != "") emit() }
      #SINK_AWK_END
    '
  fi
fi
