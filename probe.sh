#!/bin/sh
# Miracast status probe. Usage: probe.sh [fast|scan]
#
# Emits one "app=<running|stopped>" line, the `nmcli -t` device block,
# friendly peer-name tiers, a "known_begin" marker plus one tab-separated
# "known=<mac>\t<epoch>\t<alias>\t<name>" line per history entry, and --
# in scan mode only -- a P2P discovery sweep with a "sink_begin" marker
# plus one tab-separated "sink=<name>\t<hw>\t<wfd>\t<active>" line per peer.
#
# NOTE: the pgrep/pkill pattern uses the bracket trick so the probe never
# matches its own command line. `pgrep -x` cannot match this app: the name
# is longer than the 15-char comm limit. Keep the unbracketed literal out
# of this file or the probe self-matches.
mode=${1:-fast}

PLUGIN_DIR="$HOME/.config/omarchy/plugins/kili.miracast"
HIST="$HOME/.local/state/kili.miracast/history.tsv"

if pgrep -f 'gnome-network-display[s]' >/dev/null 2>&1; then
  echo app=running
else
  echo app=stopped
fi

out=$(nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status 2>/dev/null)
printf '%s\n' "$out"

line=$(printf '%s\n' "$out" | grep -m1 ':wifi-p2p:')
rest=${line#*:wifi-p2p:*:}
mac=$(printf '%s' "${rest##* }" | tr -d '\\')

peers="$PLUGIN_DIR/peers.conf"
alias_name=""; nm_name=""; mdns_name=""
if [ -n "$mac" ]; then
  [ -f "$peers" ] && alias_name=$(grep -i "^$mac=" "$peers" 2>/dev/null | head -n 1 | cut -d= -f2-)
  mac_up=$(printf '%s' "$mac" | tr 'a-z' 'A-Z')
  for pp in $(busctl --system tree org.freedesktop.NetworkManager 2>/dev/null | grep -o "/org/freedesktop/NetworkManager/WifiP2PPeer/[0-9]*"); do
    hw=$(busctl --system get-property org.freedesktop.NetworkManager "$pp" org.freedesktop.NetworkManager.WifiP2PPeer HwAddress 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')
    hw_up=$(printf '%s' "$hw" | tr 'a-z' 'A-Z')
    if [ "$hw_up" = "$mac_up" ]; then
      nm_name=$(busctl --system get-property org.freedesktop.NetworkManager "$pp" org.freedesktop.NetworkManager.WifiP2PPeer Name 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')
      break
    fi
  done
  if [ -z "$alias_name" ]; then
    ip=$(ip neigh 2>/dev/null | grep -i "$mac" | head -n 1 | awk '{print $1}')
    if [ -n "$ip" ]; then
      host=$(timeout 2 avahi-resolve-address "$ip" 2>/dev/null | awk '{print $2}')
      mdns_name=${host%.local}
    fi
  fi
fi
echo "alias_name=$alias_name"
echo "nm_name=$nm_name"
echo "mdns_name=$mdns_name"

echo known_begin
if [ -f "$HIST" ]; then
  while IFS= read -r hline; do
    [ -z "$hline" ] && continue
    h_mac=$(printf '%s\n' "$hline" | cut -f1)
    h_epoch=$(printf '%s\n' "$hline" | cut -f2)
    h_name=$(printf '%s\n' "$hline" | cut -f3-)
    h_alias=""
    if [ -n "$h_mac" ]; then
      [ -f "$peers" ] && h_alias=$(grep -i "^$h_mac=" "$peers" 2>/dev/null | head -n 1 | cut -d= -f2-)
    fi
    printf 'known=%s\t%s\t%s\t%s\n' "$h_mac" "$h_epoch" "$h_alias" "$h_name"
  done < "$HIST"
fi

if [ "$mode" = scan ]; then
  echo sink_begin
  p2pdev=${line%%:*}
  p2p_path=""
  if [ -n "$p2pdev" ]; then
    for dp in $(busctl --system tree org.freedesktop.NetworkManager 2>/dev/null | grep -o "/org/freedesktop/NetworkManager/Devices/[0-9]*"); do
      iface=$(busctl --system get-property org.freedesktop.NetworkManager "$dp" org.freedesktop.NetworkManager.Device Interface 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')
      if [ "$iface" = "$p2pdev" ]; then p2p_path=$dp; break; fi
    done
  fi
  if [ -n "$p2p_path" ]; then
    busctl --system call org.freedesktop.NetworkManager "$p2p_path" org.freedesktop.NetworkManager.Device.WifiP2P StartFind a{sv} 0 >/dev/null 2>&1
    sleep 6
    for pp in $(busctl --system get-property org.freedesktop.NetworkManager "$p2p_path" org.freedesktop.NetworkManager.Device.WifiP2P Peers 2>/dev/null | grep -o "/org/freedesktop/NetworkManager/WifiP2PPeer/[0-9]*"); do
      s_name=$(busctl --system get-property org.freedesktop.NetworkManager "$pp" org.freedesktop.NetworkManager.WifiP2PPeer Name 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')
      s_hw=$(busctl --system get-property org.freedesktop.NetworkManager "$pp" org.freedesktop.NetworkManager.WifiP2PPeer HwAddress 2>/dev/null | sed -n 's/^s "\(.*\)"$/\1/p')
      s_wfd_n=$(busctl --system get-property org.freedesktop.NetworkManager "$pp" org.freedesktop.NetworkManager.WifiP2PPeer WfdIEs 2>/dev/null | awk '{print $2}')
      s_wfd=0; [ "$s_wfd_n" -gt 0 ] 2>/dev/null && s_wfd=1
      s_active=0; s_hw_up=$(printf '%s' "$s_hw" | tr 'a-z' 'A-Z')
      if [ -n "$mac_up" ] && [ "$s_hw_up" = "$mac_up" ]; then s_active=1; fi
      printf 'sink=%s\t%s\t%s\t%s\n' "$s_name" "$s_hw" "$s_wfd" "$s_active"
    done
    busctl --system call org.freedesktop.NetworkManager "$p2p_path" org.freedesktop.NetworkManager.Device.WifiP2P StopFind >/dev/null 2>&1
  fi
fi
