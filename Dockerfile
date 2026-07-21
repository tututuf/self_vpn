FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY admin.config.example.json ./
COPY hy2.yaml ./hy2.yaml
COPY docker/host-systemctl /usr/local/bin/host-systemctl
COPY docker/host-journalctl /usr/local/bin/host-journalctl

RUN chmod +x /usr/local/bin/host-systemctl /usr/local/bin/host-journalctl

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8787 \
  ADMIN_CONFIG_PATH=/config/admin.config.json \
  SYSTEMCTL_BIN=/usr/local/bin/host-systemctl \
  JOURNALCTL_BIN=/usr/local/bin/host-journalctl

EXPOSE 8787

CMD ["node", "server.js"]