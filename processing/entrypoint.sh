#!/bin/bash
set -e

READSB_NET_RO_PORT="${READSB_NET_RO_PORT:-30002}"
READSB_NET_SBS_PORT="${READSB_NET_SBS_PORT:-30003}"
READSB_NET_BO_PORT="${READSB_NET_BO_PORT:-30005}"
READSB_NET_RI_PORT="${READSB_NET_RI_PORT:-30001}"
READSB_EXTRA_ARGS="${READSB_EXTRA_ARGS:-}"

CAPTURE_SERVICE_TYPE="_rtltcp._tcp"
ANNOUNCE_SERVICE_TYPE="_readsb._tcp"
BASE_NAME="gaia-radio-processing"

DISCOVERY_TIMEOUT="${DISCOVERY_TIMEOUT:-30}"
DISCOVERY_RETRY_INTERVAL="${DISCOVERY_RETRY_INTERVAL:-5}"

# ---------- mDNS helpers ----------

start_mdns() {
    if [ ! -d /run/dbus ]; then
        mkdir -p /run/dbus
    fi
    dbus-daemon --system --nofork &
    sleep 0.5

    avahi-daemon --daemonize --no-chroot 2>/dev/null || true
    sleep 1
}

find_next_instance() {
    local service_type="$1"
    local base_name="$2"
    local max_num=0

    local raw
    raw=$(avahi-browse -t -p -r "$service_type" 2>/dev/null || true)

    while IFS=';' read -r iface protocol resolved name stype domain hostname addr port txt; do
        if [[ "$resolved" == "=" && "$name" =~ ^${base_name}-([0-9]+)$ ]]; then
            local num="${BASH_REMATCH[1]}"
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

# Discover the first available instance of a service type.
# Returns "host:port" on stdout, or exits if not found within timeout.
discover_service() {
    local service_type="$1"
    local deadline=$((SECONDS + DISCOVERY_TIMEOUT))

    echo "[mdns] Waiting for upstream service ${service_type}..." >&2

    while (( SECONDS < deadline )); do
        local raw
        raw=$(avahi-browse -t -p -r "$service_type" 2>/dev/null || true)

        while IFS=';' read -r iface protocol resolved name stype domain hostname addr port txt; do
            if [[ "$resolved" == "=" && -n "$addr" && -n "$port" ]]; then
                echo "[mdns] Found: ${name} at ${addr}:${port}" >&2
                echo "${addr}:${port}"
                return 0
            fi
        done <<< "$raw"

        echo "[mdns] No ${service_type} found yet, retrying in ${DISCOVERY_RETRY_INTERVAL}s..." >&2
        sleep "$DISCOVERY_RETRY_INTERVAL"
    done

    echo "[mdns] ERROR: Could not find ${service_type} within ${DISCOVERY_TIMEOUT}s" >&2
    return 1
}

# ---------- Main ----------

echo "[processing] Starting mDNS subsystem..."
start_mdns

echo "[processing] Discovering capture service (${CAPTURE_SERVICE_TYPE})..."
CAPTURE_ENDPOINT=$(discover_service "$CAPTURE_SERVICE_TYPE")
CAPTURE_HOST="${CAPTURE_ENDPOINT%%:*}"
CAPTURE_PORT="${CAPTURE_ENDPOINT##*:}"
echo "[processing] Will connect to rtl_tcp at ${CAPTURE_HOST}:${CAPTURE_PORT}"

echo "[processing] Discovering existing processing instances..."
INSTANCE_NUM=$(find_next_instance "$ANNOUNCE_SERVICE_TYPE" "$BASE_NAME")
INSTANCE_NAME="${BASE_NAME}-${INSTANCE_NUM}"
echo "[processing] This instance will be: ${INSTANCE_NAME}"

announce_service "$INSTANCE_NAME" "$ANNOUNCE_SERVICE_TYPE" "$READSB_NET_BO_PORT"

echo "[processing] Starting readsb..."
exec /usr/local/bin/readsb \
    --metric \
    --net \
    --device-type rtltcp \
    --device "rtltcp:${CAPTURE_HOST}:${CAPTURE_PORT}" \
    --net-bo-port "$READSB_NET_BO_PORT" \
    --net-ro-port "$READSB_NET_RO_PORT" \
    --net-sbs-port "$READSB_NET_SBS_PORT" \
    --net-ri-port "$READSB_NET_RI_PORT" \
    --write-json /run/readsb \
    --write-json-every 1 \
    --json-location-accuracy 2 \
    $READSB_EXTRA_ARGS
