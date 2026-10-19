#!/usr/bin/env bash
set -euo pipefail

[[ -f /.dockerenv && $(readlink /proc/1/ns/net) == "$(readlink /proc/self/ns/net)" ]] || { printf 'Run only as the isolated lab container\n' >&2; exit 1; }
case "${1:-}" in init|shape) ;; *) exit 2 ;; esac
lab_action=$1 lab_rate=${2:?} lab_rtt=${3:?}
[[ "$lab_rate" == 100 || "$lab_rate" == 300 ]] || exit 2
[[ "$lab_rtt" =~ ^[0-9]+$ && "$lab_rtt" -ge 1 && "$lab_rtt" -le 1000 ]] || exit 2

shape_link() {
  local role=$1 interface=$2 delay_us=$3
  ip netns exec "h7-$role" tc qdisc replace dev "$interface" root handle 1: tbf rate "${lab_rate}mbit" burst 32768 latency 50ms
  ip netns exec "h7-$role" tc qdisc replace dev "$interface" parent 1:1 handle 10: netem delay "${delay_us}us" limit 8192
}

if [[ "$lab_action" == init ]]; then
  # Docker's private mount namespace only; these sysctls remain per-netns.
  mount --bind /proc/sys /proc/sys
  mount -o remount,bind,rw /proc/sys
  for role in client forward access origin; do
    ip netns add "h7-$role"
    ip -n "h7-$role" link set lo up
  done
  ip link add c0 type veth peer name f0
  ip link add f1 type veth peer name a0
  ip link add a1 type veth peer name o0
  ip link set c0 netns h7-client
  ip link set f0 netns h7-forward
  ip link set f1 netns h7-forward
  ip link set a0 netns h7-access
  ip link set a1 netns h7-access
  ip link set o0 netns h7-origin
  while read -r role interface v4 v6; do
    ip -n "h7-$role" link set "$interface" mtu 1500 addrgenmode none
    ip -n "h7-$role" addr add "$v4/24" dev "$interface"
    ip -n "h7-$role" -6 addr add "$v6/64" dev "$interface" nodad
    ip -n "h7-$role" -6 addr add "fe80::${v4##*.}/64" dev "$interface" nodad
    ip netns exec "h7-$role" ethtool -K "$interface" tso off gso off gro off
    ip -n "h7-$role" link set "$interface" up
  done <<'INTERFACES'
client c0 10.77.1.2 fd77:1::2
forward f0 10.77.1.1 fd77:1::1
forward f1 10.77.2.1 fd77:2::1
access a0 10.77.2.2 fd77:2::2
access a1 10.77.3.1 fd77:3::1
origin o0 10.77.3.2 fd77:3::2
INTERFACES
  for role in forward access; do
    ip netns exec "h7-$role" sysctl -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1
  done
  ip -n h7-client route add default via 10.77.1.1
  ip -n h7-client -6 route add default via fd77:1::1
  ip -n h7-forward route add 10.77.3.0/24 via 10.77.2.2
  ip -n h7-forward -6 route add fd77:3::/64 via fd77:2::2
  ip -n h7-access route add 10.77.1.0/24 via 10.77.2.1
  ip -n h7-access -6 route add fd77:1::/64 via fd77:2::1
  ip -n h7-origin route add default via 10.77.3.1
  ip -n h7-origin -6 route add default via fd77:3::1
fi

# Sum of the six one-way delays: RTT * (160+160+260+260+80+80) us.
shape_link client c0 "$((lab_rtt * 160))"
shape_link forward f0 "$((lab_rtt * 160))"
shape_link forward f1 "$((lab_rtt * 260))"
shape_link access a0 "$((lab_rtt * 260))"
shape_link access a1 "$((lab_rtt * 80))"
shape_link origin o0 "$((lab_rtt * 80))"
printf '{"rate_mbps":%s,"rtt_ms":%s,"cpu_model":"container cpuset, shared host kernel; not vCPU VM","offloads":"TSO/GSO/GRO disabled on all six veth interfaces"}\n' "$lab_rate" "$lab_rtt" > /run/h7-profile.json
if [[ "$lab_action" == init ]]; then
  touch /run/h7-netlab-ready
  exec sleep infinity
fi

