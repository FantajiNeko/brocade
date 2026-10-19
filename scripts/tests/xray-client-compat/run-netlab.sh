#!/usr/bin/env bash
set -euo pipefail

# The existing lab changes only veths/sysctls inside its private container.
# Never run these qdisc commands against a host interface.
test_scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test_artifacts=${1:?usage: run-netlab.sh ABS_TARGET_ROOT ABS_RESULTS_ROOT UNIQUE_NAME RATE LOSS [run.cjs options...]}
export NETLAB_RESULTS=${2:?}
test_name=${3:?}
test_rate=${4:?}
test_loss=${5:?}
shift 5
[[ "$test_artifacts" == /* && "$NETLAB_RESULTS" == /* && "$test_name" =~ ^h7-h11-[a-z0-9-]{1,33}$ ]] || exit 2
[[ "$test_rate" == 100 || "$test_rate" == 300 ]] || exit 2
[[ "$test_loss" == 0 || "$test_loss" == 0.1 ]] || exit 2
export NETLAB_ARTIFACTS="$test_artifacts"
export NETLAB_IMAGE=${NETLAB_IMAGE:-brocade-h7-netlab:local}
mkdir -p "$NETLAB_RESULTS"
test_lab="$test_scripts/../xray-handoff/netlab/netlab.sh"
if docker inspect "$test_name" >/dev/null 2>&1; then
  printf 'Refusing existing container: %s\n' "$test_name" >&2
  exit 1
fi
cleanup() {
  if docker inspect "$test_name" >/dev/null 2>&1; then
    bash "$test_lab" down "$test_name"
  fi
}
test_runner_pid=''
on_signal() {
  if [[ -n "$test_runner_pid" ]] && kill -0 "$test_runner_pid" 2>/dev/null; then
    kill -TERM "$test_runner_pid"
    wait "$test_runner_pid" || true
  fi
  exit 130
}
trap cleanup EXIT
trap on_signal TERM INT
bash "$test_lab" up "$test_name" "$test_rate" 2,4,6,8 25 > "$NETLAB_RESULTS/$test_name-up.log"
test_result="$NETLAB_RESULTS/$test_name"
if [[ "$test_loss" == 0.1 ]]; then
  docker exec "$test_name" ip netns exec h7-client tc qdisc change dev c0 parent 1:1 handle 10: netem delay 4000us loss 0.1% limit 8192
  docker exec "$test_name" ip netns exec h7-origin tc qdisc change dev o0 parent 1:1 handle 10: netem delay 2000us loss 0.1% limit 8192
fi
printf '{"rtt_ms":25,"rate_mbps":%s,"loss_percent_per_selected_egress":%s,"loss_egresses":["client/c0","origin/o0"],"cpuset":"2,4,6,8","memory_limit":"2g","kind":"container-shared-kernel-not-vm","offloads":"all-veth-tso-gso-gro-disabled"}\n' "$test_rate" "$test_loss" > "$test_result/requested-profile.json"
docker exec "$test_name" ip netns exec h7-client ping -n -c 3 -i 0.1 10.77.3.2 > "$test_result/ping.txt"
bash "$test_lab" status "$test_name" > "$test_result/before.json"
set +e
node "$test_scripts/run.cjs" "$@" --output "$test_result/run" --container "$test_name" --artifact-root "$test_artifacts" --container-result /results/run &
test_runner_pid=$!
wait "$test_runner_pid"
test_status=$?
test_runner_pid=''
set -e
bash "$test_lab" status "$test_name" > "$test_result/after.json"
docker exec "$test_name" chown -R "$(id -u):$(id -g)" /results
node "$test_scripts/network.cjs" "$test_result" > "$test_result/network-summary.json"
exit "$test_status"
