# gaia-radio

ADS-B aircraft tracking stack split into three independently deployable containers that discover each other over the local network using mDNS (Avahi).

## Architecture

```
┌─────────────────────┐      ┌─────────────────────────┐      ┌──────────────────────┐
│  gaia-radio-capture │      │  gaia-radio-processing  │      │   gaia-radio-web     │
│                     │      │                         │      │                      │
│  readsb (RTL-SDR)   │─────▶│  readsb (net-only)      │─────▶│  tar1090 + lighttpd  │
│  Decodes ADS-B on   │Beast │  Aggregates Beast feeds │ JSON │  Web UI on port 8080 │
│  the capture device │      │                         │      │                      │
│  Announces:         │      │  Discovers:             │      │  Connects via env:   │
│ _adsbbeast._tcp     │      │   _adsbbeast._tcp       │      │  PROCESSING_HOST     │
│  :30005             │      │  Announces:             │      │  PROCESSING_PORT     │
│                     │      │   _readsb._tcp          │      │                      │
└─────────────────────┘      └─────────────────────────┘      └──────────────────────┘
     (e.g. Raspberry Pi)          (any host)                       (any host)
```

Each container uses **mDNS service discovery** to find its upstream dependency — no hardcoded IPs or manual configuration needed. Multiple capture units are supported; each one registers itself with a sequential name (`gaia-radio-capture-01`, `-02`, etc.).

## Prerequisites

- Docker or Podman with compose support
- An RTL-SDR USB dongle (for capture)
- **avahi-daemon running on each host** (for processing and web containers that rely on the host's mDNS stack)
- The kernel DVB driver must be **blacklisted** on the capture host so it doesn't claim the RTL-SDR device

### Blacklist kernel DVB driver (capture host only)

```bash
echo 'blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830' | sudo tee /etc/modprobe.d/blacklist-rtlsdr.conf
sudo rmmod dvb_usb_rtl28xxu rtl2832 rtl2830 2>/dev/null || true
```

Unplug/replug the dongle or reboot after this.

### Enable avahi-daemon (processing and web hosts)

```bash
sudo apt install avahi-daemon
sudo systemctl enable --now avahi-daemon
```

## Containers

### gaia-radio-capture

Runs `readsb` with `--device-type rtlsdr` to decode ADS-B data directly on the capture device and expose Beast output over the network. Runs its **own avahi-daemon** inside the container since it typically runs on standalone hardware (e.g. a Raspberry Pi).

**Must be run with `--network host`** so mDNS multicast traffic reaches the LAN.

```bash
# Build
docker build -t gaia-radio-capture ./capture

# Run
docker run -d \
    --name gaia-radio-capture \
    --network host \
    --privileged \
    --device /dev/bus/usb:/dev/bus/usb \
    -e READSB_DEVICE_INDEX=0 \
    -e READSB_NET_BO_PORT=30005 \
    gaia-radio-capture
```

| Environment Variable     | Default   | Description                          |
|--------------------------|-----------|--------------------------------------|
| `READSB_DEVICE_INDEX`    | `0`       | RTL-SDR device index                 |
| `READSB_NET_BO_PORT`     | `30005`   | Beast output port                    |
| `READSB_EXTRA_ARGS`      | (empty)   | Additional arguments for readsb      |

### gaia-radio-processing

Runs `readsb` in network-only mode. Discovers `gaia-radio-capture` over mDNS and connects to its Beast output using `--net-connector`. Announces itself as a `_readsb._tcp` service.

Runs its **own avahi-daemon** inside the container for mDNS discovery and announcement.

**Must be run with `--network host`** so mDNS multicast reaches the LAN and readsb network ports are reachable.

```bash
# Build
docker build -t gaia-radio-processing ./processing

# Run
docker run -d \
    --name gaia-radio-processing \
    --network host \
    -e READSB_NET_BO_PORT=30005 \
    -e READSB_NET_RO_PORT=30002 \
    -e READSB_NET_SBS_PORT=30003 \
    -e DISCOVERY_TIMEOUT=60 \
    gaia-radio-processing
```

| Environment Variable       | Default | Description                             |
|----------------------------|---------|-----------------------------------------|
| `READSB_NET_BO_PORT`      | `30005` | Beast output port                       |
| `READSB_NET_RO_PORT`      | `30002` | Raw output port                         |
| `READSB_NET_SBS_PORT`     | `30003` | SBS/BaseStation output port             |
| `READSB_NET_RI_PORT`      | `30001` | Raw input port                          |
| `READSB_EXTRA_ARGS`       | (empty) | Additional arguments for readsb         |
| `DISCOVERY_TIMEOUT`       | `30`    | Seconds to wait for capture service     |
| `DISCOVERY_RETRY_INTERVAL`| `5`     | Seconds between discovery retries       |

### gaia-radio-web

Runs `tar1090` served by lighttpd. Connects to `gaia-radio-processing` to fetch aircraft JSON data.

Connects directly via `PROCESSING_HOST` and `PROCESSING_PORT` environment variables (defaults to `localhost:30005`, which works when colocated with processing on the same host).

**Must be run with `--network host`** so it can reach readsb ports.

```bash
# Build
docker build -t gaia-radio-web ./web

# Run (same host as processing)
docker run -d \
    --name gaia-radio-web \
    --network host \
    -e WEB_PORT=8080 \
    gaia-radio-web

# Run (different host from processing)
docker run -d \
    --name gaia-radio-web \
    --network host \
    -e WEB_PORT=8080 \
    -e PROCESSING_HOST=192.168.1.50 \
    -e PROCESSING_PORT=30005 \
    gaia-radio-web
```

The tar1090 web UI is available at `http://<host>:8080`.

| Environment Variable       | Default     | Description                              |
|----------------------------|-------------|------------------------------------------|
| `WEB_PORT`                 | `8080`      | Port for the web UI                      |
| `PROCESSING_HOST`          | `localhost` | Hostname/IP of the readsb instance       |
| `PROCESSING_PORT`          | `30005`     | Beast output port on the readsb instance |
| `READSB_JSON_PORT`         | same as `PROCESSING_PORT` | Port for JSON HTTP API  |

## Running with Docker Compose

The included `compose.yaml` runs the processing and web containers on a single host. The capture container is expected to run on separate hardware.

```bash
docker compose up --build
```

Or with Podman:

```bash
podman compose up --build
```

> **Note:** The compose file uses `network_mode: host` for all services. Processing uses mDNS to discover capture on the LAN. Web connects to processing directly via `localhost` since they share the same host.

## Running capture on a Raspberry Pi

On the Pi:

```bash
# Build and run capture
docker build -t gaia-radio-capture ./capture
docker run -d \
    --name gaia-radio-capture \
    --network host \
    --privileged \
    --device /dev/bus/usb:/dev/bus/usb \
    --restart unless-stopped \
    gaia-radio-capture
```

On the server (processing + web):

```bash
docker compose up --build -d
```

The processing container will automatically discover the capture instance on the Pi via mDNS.

## Multiple capture units

Each capture container auto-registers with a sequential name:

- `gaia-radio-capture-01`
- `gaia-radio-capture-02`
- etc.

The processing container connects to the **first** capture service it discovers. To run multiple processing instances (one per capture), run separate containers.

## Verify mDNS discovery

To check what services are visible on the network:

```bash
# See capture instances
avahi-browse -r _adsbbeast._tcp

# See processing instances
avahi-browse -r _readsb._tcp
```

## CI/CD

The GitHub Actions workflow in `.github/workflows/build-and-publish.yml` builds all three container images for `linux/amd64` and `linux/arm64` and pushes them to Docker Hub.

**Required GitHub repository configuration:**

| Type   | Name                | Value                         |
|--------|---------------------|-------------------------------|
| Secret | `DOCKERHUB_USERNAME`| Your Docker Hub username      |
| Secret | `DOCKERHUB_TOKEN`   | A Docker Hub access token     |
