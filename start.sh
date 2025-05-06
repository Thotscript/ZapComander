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

  # Confirma se iniciou
  if ! pgrep -x Xvfb > /dev/null; then
    echo "❌ Falha ao iniciar Xvfb. Abortando."
    exit 1
  fi
  echo "✅ Xvfb iniciado com sucesso."
fi

echo "🐳 Iniciando docker-compose em /root/wpptalk_server/mysql/..."
cd /root/wpptalk_server/mysql/
docker-compose up -d

if [ $? -ne 0 ]; then
  echo "❌ Erro ao iniciar docker-compose. Abortando."
  exit 1
fi
echo "✅ docker-compose iniciado com sucesso."

echo "🚀 Iniciando servidor Node.js..."
node /root/wpptalk_server/Orlando_AI_Broker/server.js
