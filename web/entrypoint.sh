#!/bin/bash
set -e

WEB_PORT="${WEB_PORT:-8080}"

# Direct connection to processing (readsb).
# Set PROCESSING_HOST and PROCESSING_PORT to connect without mDNS.
# Defaults to localhost:30005 (same host as processing).
PROCESSING_HOST="${PROCESSING_HOST:-localhost}"
PROCESSING_PORT="${PROCESSING_PORT:-30005}"

# ---------- Main ----------

echo "[web] Connecting to readsb at ${PROCESSING_HOST}:${PROCESSING_PORT}"

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
READSB_JSON_PORT="${READSB_JSON_PORT:-${PROCESSING_PORT}}"
/usr/local/bin/fetch-readsb-json.sh "$PROCESSING_HOST" "$READSB_JSON_PORT" &

echo "[web] Starting lighttpd on port ${WEB_PORT}..."
exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
