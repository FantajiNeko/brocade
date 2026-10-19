#!/usr/bin/env bash
set -euo pipefail

lab_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
lab_image=${NETLAB_IMAGE:-brocade-h9-netlab:local}
lab_label=brocade.h7.netlab
lab_results=${NETLAB_RESULTS:?set NETLAB_RESULTS to a fresh H9 result root}
[[ "$lab_results" == /* && "$lab_results" != / && "$lab_results" != *,* ]] || exit 2

usage() {
  printf '%s\n' 'netlab.sh build | up NAME {100|300} CPUSET [RTT_MS=25] | exec NAME ROLE COMMAND... | shape NAME {100|300} [RTT_MS=25] | smoke NAME | status NAME | down NAME' >&2
  exit 2
}
name_valid() { [[ "$1" =~ ^h7-[a-z0-9][a-z0-9-]{0,40}$ ]] || usage; }
owned() {
  name_valid "$1"
  [[ $(docker inspect -f "{{index .Config.Labels \"$lab_label\"}}" "$1") == 1 ]] || { printf 'Refusing foreign container: %s\n' "$1" >&2; exit 1; }
  [[ $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$1") == none ]] || { printf 'Expected isolated network namespace\n' >&2; exit 1; }
}
role_valid() { case "$1" in client|forward|access|origin) ;; *) usage ;; esac; }
profile_valid() {
  [[ "$1" == 100 || "$1" == 300 ]] || usage
  [[ "$2" =~ ^[0-9]+$ && "$2" -ge 1 && "$2" -le 1000 ]] || usage
}

[[ $# -ge 1 ]] || usage
lab_cmd=$1
shift
case "$lab_cmd" in
  build)
    [[ $# == 0 ]] || usage
    docker build --tag "$lab_image" "$lab_root"
    ;;
  up)
    [[ $# -ge 3 && $# -le 4 ]] || usage
    lab_name=$1 lab_rate=$2 lab_cpus=$3 lab_rtt=${4:-25}
    name_valid "$lab_name"
    profile_valid "$lab_rate" "$lab_rtt"
    [[ "$lab_cpus" =~ ^[0-9]+([,-][0-9]+)*$ ]] || usage
    if docker inspect "$lab_name" >/dev/null 2>&1; then
      printf 'Container already exists; choose a new name or explicitly down the owned lab\n' >&2
      exit 1
    fi
    if [[ -e "$lab_results/$lab_name" ]]; then
      printf 'Evidence directory already exists; choose a fresh lab name\n' >&2
      exit 1
    fi
    mkdir -p "$lab_results/$lab_name"
    docker image inspect "$lab_image" --format '{{json .RepoTags}} {{.Id}}' > "$lab_results/$lab_name/image-id.txt"
    lab_mounts=(--mount "type=bind,src=$lab_root,dst=/netlab,readonly" --mount "type=bind,src=$lab_results/$lab_name,dst=/results")
    if [[ -n ${NETLAB_ARTIFACTS:-} ]]; then
      [[ "$NETLAB_ARTIFACTS" == /* && -d "$NETLAB_ARTIFACTS" && "$NETLAB_ARTIFACTS" != *,* && "$NETLAB_ARTIFACTS" != / ]] || usage
      lab_mounts+=(--mount "type=bind,src=$NETLAB_ARTIFACTS,dst=/artifacts,readonly")
    fi
    docker run --detach --name "$lab_name" --label "$lab_label=1" \
      --network none --cpuset-cpus "$lab_cpus" --memory 2g --pids-limit 512 \
      --cap-add NET_ADMIN --cap-add SYS_ADMIN \
      --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
      "${lab_mounts[@]}" "$lab_image" /bin/bash /netlab/inside.sh init "$lab_rate" "$lab_rtt"
    for ((lab_try=0;lab_try<50;lab_try++)); do
      if docker exec "$lab_name" test -f /run/h7-netlab-ready 2>/dev/null; then
        docker exec "$lab_name" python3 /netlab/probe.py snapshot | tee "$lab_results/$lab_name/initial.json"
        exit 0
      fi
      [[ $(docker inspect -f '{{.State.Running}}' "$lab_name") == true ]] || break
      sleep 0.1
    done
    docker logs "$lab_name" >&2
    printf 'Lab setup failed; retained owned container for inspection. Run down explicitly.\n' >&2
    exit 1
    ;;
  exec)
    [[ $# -ge 3 ]] || usage
    owned "$1"
    role_valid "$2"
    lab_name=$1 lab_role=$2
    shift 2
    docker exec "$lab_name" ip netns exec "h7-$lab_role" "$@"
    ;;
  shape)
    [[ $# -ge 2 && $# -le 3 ]] || usage
    owned "$1"
    profile_valid "$2" "${3:-25}"
    docker exec "$1" /bin/bash /netlab/inside.sh shape "$2" "${3:-25}"
    ;;
  smoke)
    [[ $# == 1 ]] || usage
    owned "$1"
    lab_stamp=$(date -u +%Y%m%dT%H%M%S)-$$
    docker exec "$1" python3 /netlab/probe.py smoke | tee "$lab_results/$1/smoke-$lab_stamp.json"
    ;;
  status)
    [[ $# == 1 ]] || usage
    owned "$1"
    docker exec "$1" python3 /netlab/probe.py snapshot
    ;;
  down)
    [[ $# == 1 ]] || usage
    owned "$1"
    docker logs "$1" >"$lab_results/$1/container.log" 2>&1
    docker rm --force "$1"
    printf 'Removed only owned container %s; logs retained in %s/%s\n' "$1" "$lab_results" "$1"
    ;;
  *) usage ;;
esac
