# Orlando AI Broker — WhatsApp Automation Server

Servidor de automação WhatsApp multi-sessão com transcrição de áudio via Whisper local, comunicação em tempo real por WebSocket e banco de dados MySQL para persistência de sessões.

---

## Funcionalidades

- Autenticação de múltiplas sessões WhatsApp via QR Code
- Transmissão do QR Code em tempo real via WebSocket
- Transcrição automática de áudios recebidos com Whisper local (fallback para API OpenAI)
- Redução de ruído de áudio com FFmpeg
- Persistência de sessões e logs em MySQL
- Suporte a HTTPS com TLS em produção
- Restauração automática de sessões ao reiniciar o servidor

---

## Pré-requisitos

### 1. Node.js
Versão 18 ou superior (necessário suporte nativo a ES Modules).

```bash
node -v  # >= 18.0.0
```

### 2. MySQL
Versão 8.0 ou superior. Crie o banco e o usuário conforme o `.env`:

```sql
CREATE DATABASE wpptalk_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wpptalk'@'localhost' IDENTIFIED BY 'wpptalk1234';
GRANT ALL PRIVILEGES ON wpptalk_db.* TO 'wpptalk'@'localhost';
FLUSH PRIVILEGES;
```

### 3. FFmpeg
Necessário para redução de ruído de áudio.

- **Windows:** Baixe em [ffmpeg.org](https://ffmpeg.org/download.html) e adicione ao PATH
- **Linux/Mac:** `sudo apt install ffmpeg` / `brew install ffmpeg`

Verifique:
```bash
ffmpeg -version
```

### 4. Python + Whisper
Necessário para transcrição local de áudios.

```bash
# Python 3.8–3.11 recomendado
pip install openai-whisper
```

Verifique:
```bash
whisper --help
```

> Na primeira transcrição o modelo escolhido (padrão: `small`) será baixado automaticamente.

### 5. Chromium (automático)
O `@wppconnect-team/wppconnect` baixa e gerencia seu próprio Chromium automaticamente via Puppeteer. Nenhuma instalação manual necessária.

---

## Instalação

```bash
git clone https://github.com/seu-usuario/orlando-ai-broker.git
cd orlando-ai-broker
npm install
```

---

## Configuração

Crie o arquivo `.env` na raiz do projeto:

```env
# Chave da API OpenAI (fallback para Whisper API quando local falhar)
OPENAI_API_KEY=sk-...

# Porta do servidor HTTP/HTTPS
PORT=8443

# Token de segurança interno
SECRET_TOKEN=sua_chave_secreta

# Ambiente: development | production
NODE_ENV=development

# URL base para montar links de QR Code (sem barra final)
BASE_URL=http://localhost:8443

# Origem permitida no CORS (* para dev, domínio real para prod)
CORS_ORIGIN=*

# LM Studio — endpoint e modelo local para pós-processamento de IA
LMSTUDIO_BASE_URL=http://localhost:1234/v1
LMSTUDIO_MODEL=nome-do-modelo-carregado

# Whisper local — modelo de transcrição
# Opções: tiny | base | small | medium | large
WHISPER_MODEL=small
```

---

## Estrutura de Tabelas MySQL

```sql
CREATE TABLE usuarios (
  email VARCHAR(255) PRIMARY KEY,
  plano VARCHAR(50) DEFAULT 'free',
  limite_minutos_mensal INT DEFAULT 0
);

CREATE TABLE sessoes (
  numero VARCHAR(50) PRIMARY KEY,
  usuario_email VARCHAR(255),
  status VARCHAR(50),
  FOREIGN KEY (usuario_email) REFERENCES usuarios(email)
);

CREATE TABLE logs_sessao (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255),
  sessao_numero VARCHAR(50),
  ultimo_acesso DATETIME,
  FOREIGN KEY (sessao_numero) REFERENCES sessoes(numero) ON DELETE CASCADE
);

CREATE TABLE filtros (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sessao_numero VARCHAR(50),
  FOREIGN KEY (sessao_numero) REFERENCES sessoes(numero) ON DELETE CASCADE
);
```

---

## Executando

```bash
# Desenvolvimento (HTTP)
node server.js

# Produção (HTTPS — requer config/https.js com certificado TLS)
NODE_ENV=production node server.js
```

---

## Uso da API

### Iniciar sessão (gera QR Code)
```bash
curl -X POST http://localhost:8443/auth/login \
  -H "Content-Type: application/json" \
  -d '{"sessionName": "5511999999999", "email": "usuario@email.com"}'
```
Resposta: `{ "qrCodeFile": "http://localhost:8443/qrcodes/qrcode_5511999999999.png" }`

### Encerrar sessão
```bash
curl "http://localhost:8443/auth/logout?sessionName=5511999999999&email=usuario@email.com"
```

### Enviar mensagem de texto
```bash
curl -X POST http://localhost:8443/send-text \
  -H "Content-Type: application/json" \
  -d '{"sessionName": "5511999999999", "to": "5511888888888@c.us", "text": "Olá!"}'
```

### Status dos dispositivos
```bash
curl "http://localhost:8443/statusdevices?email=usuario@email.com"
```

---

## WebSocket

Conecte via `ws://localhost:8443` e envie:

```json
{ "type": "requestQR", "sessionName": "5511999999999" }
```

Eventos recebidos:
- `{ "type": "qr", "sessionName": "...", "qrPath": "/qrcodes/qrcode_....png" }` — novo QR disponível
- `{ "type": "authenticated", "sessionName": "..." }` — sessão autenticada com sucesso
- `{ "type": "qrReadSuccess", "session": "...", "success": true }` — QR escaneado pelo celular

---

## Fluxo de Áudio

```
Mensagem de áudio/ptt recebida
        ↓
Salva arquivo .ogg
        ↓
FFmpeg (redução de ruído)
        ↓
Whisper local (WHISPER_MODEL)
        ↓ falhou?
API OpenAI whisper-1
        ↓
Envia transcrição ao remetente
```

---

## Tecnologias

| Biblioteca | Função |
|-----------|--------|
| `@wppconnect-team/wppconnect` | Automação WhatsApp Web |
| `express` | Servidor HTTP/HTTPS |
| `ws` | WebSocket server |
| `mysql2` | Banco de dados MySQL |
| `fluent-ffmpeg` | Manipulação de áudio |
| `axios` | Requisições HTTP |
| `helmet` | Headers de segurança |
| `luxon` | Manipulação de datas/fusos horários |
| `dotenv` | Variáveis de ambiente |
| `openai-whisper` (Python) | Transcrição de áudio local |
| `ffmpeg` (binário) | Redução de ruído de áudio |
