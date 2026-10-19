FROM ubuntu:24.04

# H9 needs namespace/network tooling only; no inherited local QEMU image is
# required for a cold rebuild. Runtime/test binaries are mounted read-only.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash ca-certificates ethtool iproute2 iputils-ping procps python3 util-linux \
    && rm -rf /var/lib/apt/lists/*
