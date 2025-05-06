#!/bin/bash

export DISPLAY=:99

# Inicia Xvfb se necessário
pgrep -x Xvfb > /dev/null || {
  echo "🚀 Iniciando Xvfb..."
  rm -f /tmp/.X99-lock
  Xvfb :99 -screen 0 1024x768x24 &
  sleep 2
}

# Inicia Docker se não estiver rodando
systemctl is-active --quiet docker || systemctl start docker

# Sobe container wpptalk_db se não estiver ativo
cd /root/wpptalk_server/mysql/
docker ps --format '{{.Names}}' | grep -q '^wpptalk_db$' || docker-compose start

# Carrega variáveis do .env
[ -f "/root/wpptalk_server/Orlando_AI_Broker/.env" ] && export $(grep -v '^#' /root/wpptalk_server/Orlando_AI_Broker/.env | xargs)

# Inicia servidor Node.js
node /root/wpptalk_server/Orlando_AI_Broker/server.js
