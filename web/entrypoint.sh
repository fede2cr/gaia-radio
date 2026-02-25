#!/bin/bash
set -e

WEB_PORT="${WEB_PORT:-8080}"
PROCESSING_SERVICE_TYPE="_readsb._tcp"

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

echo "[web] Starting mDNS subsystem..."
start_mdns

echo "[web] Discovering processing service (${PROCESSING_SERVICE_TYPE})..."
PROCESSING_ENDPOINT=$(discover_service "$PROCESSING_SERVICE_TYPE")
PROCESSING_HOST="${PROCESSING_ENDPOINT%%:*}"
PROCESSING_PORT="${PROCESSING_ENDPOINT##*:}"
echo "[web] Will fetch data from readsb at ${PROCESSING_HOST}:${PROCESSING_PORT}"

# Generate tar1090 config
cat > /var/www/html/tar1090/config.js <<JSEOF
// tar1090 configuration - auto-generated
defaultCenterLat = 0.0;
defaultCenterLon = 0.0;
defaultZoomLvl = 7;
JSEOF

# Create data directory
mkdir -p /run/readsb

# Background fetcher: pulls JSON from processing (readsb) via its HTTP interface
# readsb --net exposes an HTTP API on port 30002..30005 range; the JSON is written
# to /run/readsb by readsb, but we fetch via the network since it's on another host.
# readsb's built-in webserver (if enabled) or we fetch from its --write-json output
# via a lightweight HTTP endpoint. We use the beast/raw port to detect the host,
# but the JSON API is typically on port 8080 or we use --net-http-port on readsb.
# For simplicity, we poll the readsb JSON HTTP API.
cat > /usr/local/bin/fetch-readsb-json.sh <<'FETCHEOF'
#!/bin/bash
READSB_HOST="$1"
READSB_JSON_PORT="$2"
while true; do
    wget -q -T 2 -O /run/readsb/aircraft.json "http://${READSB_HOST}:${READSB_JSON_PORT}/data/aircraft.json" 2>/dev/null || true
    wget -q -T 2 -O /run/readsb/receiver.json "http://${READSB_HOST}:${READSB_JSON_PORT}/data/receiver.json" 2>/dev/null || true
    wget -q -T 2 -O /run/readsb/stats.json    "http://${READSB_HOST}:${READSB_JSON_PORT}/data/stats.json"    2>/dev/null || true
    sleep 1
done
FETCHEOF
chmod +x /usr/local/bin/fetch-readsb-json.sh

# Start the JSON fetcher in the background
# Note: readsb exposes JSON via its net-http-port (default 30152) when --net is used
READSB_JSON_PORT="${READSB_JSON_PORT:-${PROCESSING_PORT}}"
/usr/local/bin/fetch-readsb-json.sh "$PROCESSING_HOST" "$READSB_JSON_PORT" &

echo "[web] Starting lighttpd on port ${WEB_PORT}..."
exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
