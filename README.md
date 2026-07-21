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

Edit `admin.config.json` before running the app:

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
ADMIN_CONFIG_PATH=/opt/hy2-vpn-admin/admin.config.json
ADMIN_TOKEN=override-admin-token
DOWNLOAD_TOKEN=override-download-token
HY2_YAML_PATH=/opt/hy2-vpn-admin/hy2.yaml
VPN_SERVICE_NAME=hysteria-server.service
PORT=8787
HOST=0.0.0.0
```

## Run

```bash
npm start
```

Open:

```text
http://your-server-ip:8787
```

Download URL:

```text
http://your-server-ip:8787/download/hy2.yaml?token=your-download-token
```

## CentOS 7

Install Node.js 18 or newer, copy this project to `/opt/hy2-vpn-admin`, edit `/opt/hy2-vpn-admin/admin.config.json`, then start it:

```bash
cd /opt/hy2-vpn-admin
npm start
```

To run it as a service, copy `systemd/hy2-vpn-admin.service` to `/etc/systemd/system/hy2-vpn-admin.service`, then run:

```bash
systemctl daemon-reload
systemctl enable --now hy2-vpn-admin.service
systemctl status hy2-vpn-admin.service
```

Open firewall port if needed:

```bash
firewall-cmd --permanent --add-port=8787/tcp
firewall-cmd --reload
```