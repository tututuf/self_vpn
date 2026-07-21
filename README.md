# HY2 VPN Admin

Small Hysteria 2 admin panel for service control, YAML editing, YAML import, and YAML download.

## Service Commands

The common Hysteria 2 systemd service created by hy2.sh is `hysteria-server.service`:

```bash
systemctl start hysteria-server.service
systemctl stop hysteria-server.service
systemctl restart hysteria-server.service
systemctl status hysteria-server.service
journalctl --no-pager -e -u hysteria-server.service
```

If your script created a different service name, edit `vpnServiceName` in `admin.config.json`.

## Admin Config

Edit `admin.config.json` before running or deploying the app:

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "adminToken": "change-this-admin-token",
  "downloadToken": "change-this-download-token",
  "hy2YamlPath": "./hy2.yaml",
  "vpnServiceName": "hysteria-server.service"
}
```

`adminToken` protects admin APIs such as edit config, start, stop, restart, status, and logs.

`downloadToken` protects `/download/hy2.yaml`. The app will show a download URL with `?token=...`.

Environment variables still work and override the JSON file when set:

```bash
ADMIN_CONFIG_PATH=/config/admin.config.json
ADMIN_TOKEN=override-admin-token
DOWNLOAD_TOKEN=override-download-token
HY2_YAML_PATH=/config/hy2.yaml
VPN_SERVICE_NAME=hysteria-server.service
PORT=8787
HOST=0.0.0.0
```

## Local Run

```bash
npm start
```

Open:

```text
http://127.0.0.1:8787
```

## Docker Image

Build the image from the project root:

```bash
docker build -t hy2-vpn-admin:latest .
```

Or with npm:

```bash
npm run docker:build
```

The image does not include your real `admin.config.json`; mount it at runtime.

## Docker Deploy With Compose

Copy the whole project directory to the server, then make sure these files exist in the project root:

```text
admin.config.json
hy2.yaml
docker-compose.yml
Dockerfile
server.js
public/
docker/
```

Build and start:

```bash
cd /opt/hy2-vpn-admin
docker compose up -d --build
```

If your server uses old Compose v1:

```bash
docker-compose up -d --build
```

The compose file runs the container with `privileged: true` and `pid: host` so the admin panel can run host `systemctl` and `journalctl` through `nsenter`.

Open:

```text
http://your-server-ip:8787
```

Download URL:

```text
http://your-server-ip:8787/download/hy2.yaml?token=your-download-token
```

Useful commands:

```bash
docker compose logs -f
docker compose restart
docker compose down
```


## Docker Host Service Control

Yes, the Docker version can start, stop, restart, and inspect the host VPN service, but only because `docker-compose.yml` grants host-level access:

```yaml
privileged: true
pid: host
```

The container command wrappers use `nsenter` to enter the host namespaces and host root filesystem, then run host `/usr/bin/systemctl` and `/usr/bin/journalctl`:

```text
/usr/local/bin/host-systemctl
/usr/local/bin/host-journalctl
```

If you remove `privileged: true` or `pid: host`, the admin panel can still edit and download YAML, but host service start/stop/status/logs will not work.

This is powerful access. Only expose the admin panel behind a strong `adminToken`, and preferably restrict access by firewall or reverse proxy.
## Docker Run

Without Compose:

```bash
cd /opt/hy2-vpn-admin
docker build -t hy2-vpn-admin:latest .
docker run -d \
  --name hy2-vpn-admin \
  --restart unless-stopped \
  --privileged \
  --pid=host \
  -p 8787:8787 \
  -e ADMIN_CONFIG_PATH=/config/admin.config.json \
  -e SYSTEMCTL_BIN=/usr/local/bin/host-systemctl \
  -e JOURNALCTL_BIN=/usr/local/bin/host-journalctl \
  -v /opt/hy2-vpn-admin/admin.config.json:/config/admin.config.json:ro \
  -v /opt/hy2-vpn-admin/hy2.yaml:/config/hy2.yaml \
  hy2-vpn-admin:latest
```

If you change `port` in `admin.config.json`, update the `ports` mapping or `-p` value too.

Open firewall port if needed:

```bash
firewall-cmd --permanent --add-port=8787/tcp
firewall-cmd --reload
```