#!/bin/bash

export DISPLAY=:99

echo "🔍 Verificando se Xvfb já está rodando..."
if pgrep -x Xvfb > /dev/null; then
  echo "✅ Xvfb já está rodando. Não será reiniciado."
else
  echo "🚀 Iniciando Xvfb..."
  rm -f /tmp/.X99-lock
  Xvfb :99 -screen 0 1024x768x24 &
  sleep 2

  if ! pgrep -x Xvfb > /dev/null; then
    echo "❌ Falha ao iniciar Xvfb. Abortando."
    exit 1
  fi
  echo "✅ Xvfb iniciado com sucesso."
fi

echo "🔧 Verificando Docker..."
if ! systemctl is-active --quiet docker; then
  echo "🚀 Iniciando Docker..."
  sudo systemctl start docker
  sleep 3
fi

cd /root/wpptalk_server/mysql/

# Verifica se o container 'wpptalk_db' está rodando
if docker ps --format '{{.Names}}' | grep -q '^wpptalk_db$'; then
  echo "✅ Container 'wpptalk_db' já está ativo."
else
  echo "🐳 Container 'wpptalk_db' não está rodando. Tentando iniciar com docker-compose..."
  docker-compose start

  # Verifica novamente após tentar iniciar
  if docker ps --format '{{.Names}}' | grep -q '^wpptalk_db$'; then
    echo "✅ Container 'wpptalk_db' foi iniciado com sucesso."
  else
    echo "❌ Falha ao iniciar container 'wpptalk_db'."
    echo "   ➤ Execute manualmente: docker-compose start"
    echo "   ➤ Ou verifique com:    docker-compose ps"
    exit 1
  fi
fi

echo "🚀 Iniciando servidor Node.js..."
node /root/wpptalk_server/Orlando_AI_Broker/server.js
