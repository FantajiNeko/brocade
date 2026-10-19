#!/usr/bin/env bash
set -euo pipefail
test_scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test_artifacts=${1:?usage: run-netlab.sh ABS_TARGET_ROOT ABS_RESULTS_ROOT UNIQUE_H7_H9_NAME RATE}
export NETLAB_RESULTS=${2:?}
test_name=${3:?}
test_rate=${4:?}
[[ "$test_artifacts" == /* && "$NETLAB_RESULTS" == /* && "$test_name" =~ ^h7-h9-[a-z0-9-]+$ ]] || exit 2
case "$test_rate" in 100) test_pace=100;; 300) test_pace=30;; *) exit 2;; esac
export NETLAB_ARTIFACTS="$test_artifacts"
mkdir -p "$NETLAB_RESULTS"
test_lab="$test_scripts/netlab/netlab.sh"
if docker inspect "$test_name" >/dev/null 2>&1; then
  printf 'Refusing existing container before installing cleanup: %s\n' "$test_name" >&2
  exit 1
fi
cleanup() {
  if docker inspect "$test_name" >/dev/null 2>&1; then bash "$test_lab" down "$test_name"; fi
}
trap cleanup EXIT
bash "$test_lab" up "$test_name" "$test_rate" 2,4,6,8 > "$NETLAB_RESULTS/$test_name-up.log"
test_result="$NETLAB_RESULTS/$test_name"
docker exec "$test_name" ip netns exec h7-client ping -n -c 3 -i 0.1 10.77.3.2 > "$test_result/ping.txt"
bash "$test_lab" status "$test_name" > "$test_result/before.json"
set +e
node "$test_scripts/run-integration.cjs" --harness "$test_artifacts/h9/integration/h9-v1.test" \
  --old "$test_artifacts/h9/xray-lab-v6d" --new "$test_artifacts/h9/xray-lab-v6d" \
  --client "$test_artifacts/h7/xray-client-baseline" --output "$test_result/run" --pace "$test_pace" \
  --container "$test_name" --artifact-root "$test_artifacts" --container-result /results/run
test_status=$?
set -e
docker exec "$test_name" chown -R "$(id -u):$(id -g)" /results
bash "$test_lab" status "$test_name" > "$test_result/after.json"
PYTHONDONTWRITEBYTECODE=1 python3 "$test_scripts/summarize-network.py" "$test_result" > "$test_result/network-summary.json"
exit "$test_status"
