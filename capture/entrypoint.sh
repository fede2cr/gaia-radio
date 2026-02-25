#!/bin/bash
set -e

RTL_TCP_PORT="${RTL_TCP_PORT:-1234}"
RTL_TCP_BIND="${RTL_TCP_BIND:-0.0.0.0}"
RTL_TCP_DEVICE_INDEX="${RTL_TCP_DEVICE_INDEX:-0}"
RTL_TCP_EXTRA_ARGS="${RTL_TCP_EXTRA_ARGS:-}"
SERVICE_TYPE="_rtltcp._tcp"
BASE_NAME="gaia-radio-capture"

# ---------- mDNS helpers ----------

start_mdns() {
    # Start dbus (required by avahi)
    if [ ! -d /run/dbus ]; then
        mkdir -p /run/dbus
    fi
    dbus-daemon --system --nofork &
    sleep 0.5

    # Start avahi-daemon
    avahi-daemon --daemonize --no-chroot 2>/dev/null || true
    sleep 1
}

find_next_instance() {
    local service_type="$1"
    local base_name="$2"
    local max_num=0

    # Browse for existing services (parseable output, terminate after search)
    local raw
    raw=$(avahi-browse -t -p -r "$service_type" 2>/dev/null || true)

    while IFS=';' read -r event iface protocol name stype domain hostname addr port txt; do
        if [[ "$event" == "=" && "$name" =~ ^${base_name}-([0-9]+)$ ]]; then
            local num="${BASH_REMATCH[1]}"
            # strip leading zeros for arithmetic
            num=$((10#$num))
            if (( num > max_num )); then
                max_num=$num
            fi
        fi
    done <<< "$raw"

    printf "%02d" $((max_num + 1))
}

announce_service() {
    local instance_name="$1"
    local service_type="$2"
    local port="$3"

    echo "[mdns] Announcing: ${instance_name} (${service_type}) on port ${port}"
    avahi-publish-service \
        "${instance_name}" \
        "${service_type}" \
        "${port}" \
        "version=1" &
}

# ---------- Main ----------

echo "[capture] Starting mDNS subsystem..."
start_mdns

echo "[capture] Discovering existing capture instances..."
INSTANCE_NUM=$(find_next_instance "$SERVICE_TYPE" "$BASE_NAME")
INSTANCE_NAME="${BASE_NAME}-${INSTANCE_NUM}"
echo "[capture] This instance will be: ${INSTANCE_NAME}"

announce_service "$INSTANCE_NAME" "$SERVICE_TYPE" "$RTL_TCP_PORT"

echo "[capture] Starting rtl_tcp on ${RTL_TCP_BIND}:${RTL_TCP_PORT} (device index ${RTL_TCP_DEVICE_INDEX})..."
exec rtl_tcp \
    -a "$RTL_TCP_BIND" \
    -p "$RTL_TCP_PORT" \
    -d "$RTL_TCP_DEVICE_INDEX" \
    $RTL_TCP_EXTRA_ARGS
