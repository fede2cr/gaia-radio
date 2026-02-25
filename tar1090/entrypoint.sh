#!/bin/bash
set -e

READSB_HOST="${READSB_HOST:-readsb}"
READSB_PORT="${READSB_PORT:-30005}"

# Generate tar1090 config pointing at the readsb instance
cat > /var/www/html/tar1090/config.js <<JSEOF
// tar1090 configuration - auto-generated
defaultCenterLat = 0.0;
defaultCenterLon = 0.0;
defaultZoomLvl = 7;
JSEOF

# Create a small script that fetches JSON from readsb via network
# and writes it locally so tar1090 can serve it
mkdir -p /run/readsb

cat > /usr/local/bin/fetch-readsb-json.sh <<'FETCHEOF'
#!/bin/bash
READSB_HOST="$1"
READSB_PORT="$2"
while true; do
    wget -q -O /run/readsb/aircraft.json "http://${READSB_HOST}:${READSB_PORT}/data/aircraft.json" 2>/dev/null || true
    wget -q -O /run/readsb/receiver.json "http://${READSB_HOST}:${READSB_PORT}/data/receiver.json" 2>/dev/null || true
    wget -q -O /run/readsb/stats.json "http://${READSB_HOST}:${READSB_PORT}/data/stats.json" 2>/dev/null || true
    sleep 1
done
FETCHEOF
chmod +x /usr/local/bin/fetch-readsb-json.sh

# Start the JSON fetcher in the background
/usr/local/bin/fetch-readsb-json.sh "$READSB_HOST" "$READSB_PORT" &

# Start lighttpd in foreground
exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
