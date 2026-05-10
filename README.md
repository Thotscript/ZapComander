# ZapComander — WhatsApp Automation Platform

Plataforma multi-sessão de automação WhatsApp com agentes de IA, transcrição de áudio, RAG (Retrieval-Augmented Generation) e bots agendados. Construída com Node.js, Express, WPPConnect e OpenAI.

---

## Sumário

- [Visão Geral da Arquitetura](#visão-geral-da-arquitetura)
- [Estrutura de Diretórios](#estrutura-de-diretórios)
- [Pré-requisitos e Instalação](#pré-requisitos-e-instalação)
- [Configuração (.env)](#configuração-env)
- [Banco de Dados MySQL](#banco-de-dados-mysql)
- [Roteamento — Todos os Endpoints](#roteamento--todos-os-endpoints)
- [Funções Principais](#funções-principais)
- [Funções Auxiliares](#funções-auxiliares)
- [Tipos de Bots e Funcionamento](#tipos-de-bots-e-funcionamento)
- [Vínculo de Sessões](#vínculo-de-sessões)
- [WebSocket — Comunicação em Tempo Real](#websocket--comunicação-em-tempo-real)
- [Fluxo de Áudio e Transcrição](#fluxo-de-áudio-e-transcrição)
- [RAG — Base de Conhecimento](#rag--base-de-conhecimento)
- [Bot Agendado (Scheduler)](#bot-agendado-scheduler)
- [Segurança](#segurança)
- [Executando o Servidor](#executando-o-servidor)

---

## Visão Geral da Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                     ZAPCOMANDER PLATFORM                    │
├───────────────┬────────────────────────────┬────────────────┤
│   Frontend    │       Backend (Express)    │  Integrações   │
│               │                           │                │
│  /public/     │  server.js ──► routes/    │  OpenAI GPT    │
│  painel/      │  state.js  ──► services/  │  Whisper API   │
│  login/       │  config/   ──► db/        │  WPPConnect    │
│  admin/       │  ws/       ──► utils/     │  Puppeteer     │
└───────┬───────┴──────────┬─────────────────┴────────┬───────┘
        │                  │                           │
        ▼                  ▼                           ▼
  Browser/UI         MySQL Database             WhatsApp Web
  WebSocket          (sessoes, usuarios,        (multi-sessão)
  Real-Time          logs_sessao, filtros)
```

### Estado Global (`state.js`)

Quatro estruturas em memória coordenam toda a operação:

| Estrutura | Tipo | Conteúdo |
|-----------|------|----------|
| `SESSIONS` | `Map` | `sessionName → {client, myNumber, email}` |
| `processingQueues` | `Map` | `sessionName → Promise` (fila por sessão) |
| `RESTARTING_SESSIONS` | `Set` | Nomes de sessões em processo de restart |
| `sessionClients` | `Map` | `sessionName → WebSocket` do cliente que abriu |

---

## Estrutura de Diretórios

```
ZapComander/
├── server.js                   ← Entrada principal: HTTP/HTTPS + rotas + boot
├── state.js                    ← Estado global em memória (Maps/Sets)
├── package.json
│
├── config/
│   ├── constants.js            ← Caminhos, args do Puppeteer, fuso horário por DDI
│   └── https.js                ← TLS (produção) — certificado + chave
│
├── routes/                     ← Handlers Express (1 arquivo por domínio)
│   ├── auth.js                 ← Sessões WhatsApp: login, logout, listagem
│   ├── agents.js               ← CRUD de agentes/bots + disparo imediato
│   ├── messages.js             ← Envio de mensagens de texto
│   ├── devices.js              ← Status dos dispositivos
│   ├── usuarios.js             ← Registro e login de usuários
│   ├── admin.js                ← Painel admin com métricas
│   └── rag.js                  ← Upload, listagem e consulta de documentos RAG
│
├── services/
│   ├── session.js              ← Ciclo de vida completo das sessões WPP
│   ├── agentProcessor.js       ← Motor de conversas e execução dos bots
│   ├── botScheduler.js         ← Agendamento cron dos bots de disparo
│   ├── audio.js                ← Pipeline de transcrição (FFmpeg + Whisper)
│   └── ragProcessor.js         ← Embedding, armazenamento e busca semântica
│
├── db/
│   ├── index.js                ← Pool de conexões MySQL2
│   ├── sessions.js             ← CRUD de sessões no banco
│   ├── usuarios.js             ← CRUD + hash de senhas (scrypt)
│   ├── logs.js                 ← Log de transcrições e atividade
│   └── schema.sql              ← DDL das tabelas
│
├── ws/
│   └── websocket.js            ← Server WebSocket: QR codes, status em tempo real
│
├── utils/
│   └── helpers.js              ← Parsers, fila async, salvamento de QR
│
├── public/
│   ├── index.html              ← Landing page (marketing)
│   ├── login/index.html        ← Login e cadastro
│   ├── painel/index.html       ← Dashboard do usuário
│   ├── docs/index.html         ← Documentação de uso e configuração
│   └── admin/index.html        ← Painel administrativo
│
├── data/
│   ├── agents/                 ← Definições JSON dos agentes por e-mail
│   └── rag/                    ← Embeddings JSON por (email/sessão/agentId)
│
├── tokens/                     ← Perfis Chromium do WPPConnect
├── audios/                     ← Arquivos de áudio temporários
└── temp/                       ← QR codes PNG gerados
```

---

## Pré-requisitos e Instalação

### Requisitos de sistema

| Componente | Versão | Função |
|------------|--------|--------|
| Node.js | ≥ 18 | Runtime principal (ES Modules) |
| MySQL | ≥ 8.0 | Persistência de sessões e logs |
| FFmpeg | Qualquer | Redução de ruído de áudio |
| Python + Whisper | 3.8–3.11 | Transcrição local de áudios |
| Chromium | Automático | Gerenciado pelo WPPConnect via Puppeteer |

```bash
# Instalar dependências
npm install

# Verificar ferramentas externas
node -v          # >= 18
ffmpeg -version
whisper --help
```

---

## Configuração (.env)

```env
# ── OpenAI ──────────────────────────────────────────────────
OPENAI_API_KEY=sk-...              # Obrigatório: Whisper API + agentes GPT
AGENT_MODEL=gpt-4o-mini            # Modelo usado pelos agentes (padrão: gpt-4o-mini)

# ── Servidor ─────────────────────────────────────────────────
PORT=8443                          # Porta HTTP/HTTPS
NODE_ENV=development               # development (HTTP) | production (HTTPS)
BASE_URL=http://localhost:8443     # URL base para QR codes e redirecionamentos
CORS_ORIGIN=*                      # * para dev; domínio real para produção

# ── Segurança ────────────────────────────────────────────────
SECRET_TOKEN=sua_chave_secreta     # Token interno (reservado)
ADMIN_KEY=chave_admin              # Chave para acessar /api/admin/stats

# ── Transcrição ──────────────────────────────────────────────
WHISPER_MODEL=small                # tiny | base | small | medium | large
TRANSCRIPTION_DESTINATION=self     # self (envia ao próprio número) | sender

# ── TLS (apenas produção) ────────────────────────────────────
# Configurado em config/https.js com fs.readFileSync dos certificados
```

---

## Banco de Dados MySQL

### Schema completo (`db/schema.sql`)

```sql
CREATE TABLE usuarios (
  email                 VARCHAR(255) PRIMARY KEY,
  plano                 VARCHAR(50)  DEFAULT 'free',
  limite_minutos_mensal INT          DEFAULT 0,
  senha_hash            VARCHAR(255),
  criado_em             DATETIME     DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessoes (
  numero        VARCHAR(50)  PRIMARY KEY,
  usuario_email VARCHAR(255),
  status        VARCHAR(50),
  criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_email) REFERENCES usuarios(email)
);

CREATE TABLE logs_sessao (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  email               VARCHAR(255),
  sessao_numero       VARCHAR(50),
  ultimo_acesso       DATETIME,
  duracao_segundos    INT DEFAULT 0,
  total_transcricoes  INT DEFAULT 0,
  FOREIGN KEY (sessao_numero) REFERENCES sessoes(numero) ON DELETE CASCADE
);

CREATE TABLE filtros (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  sessao_numero VARCHAR(50),
  FOREIGN KEY (sessao_numero) REFERENCES sessoes(numero) ON DELETE CASCADE
);
```

### Funções de banco (`db/`)

| Arquivo | Função | Assinatura |
|---------|--------|------------|
| `sessions.js` | `criarOuIgnorarSessao` | `(numero, email)` |
| `sessions.js` | `atualizarStatusSessao` | `(name, status)` |
| `sessions.js` | `excluirSessaoPorEmail` | `(email, name)` |
| `usuarios.js` | `criarOuIgnorarUsuario` | `(email, plano, limite)` |
| `usuarios.js` | `registrarUsuario` | `(email, senha)` → hash scrypt |
| `usuarios.js` | `autenticarUsuario` | `(email, senha)` → boolean |
| `logs.js` | `saveSessionLog` | `({email, sessaoNumero, whatsappNumero, duracao})` |

---

## Roteamento — Todos os Endpoints

### Auth & Sessão (`routes/auth.js`)

| Método | Endpoint | Parâmetros | Descrição |
|--------|----------|------------|-----------|
| `POST` | `/auth/login` | `{sessionName, email}` body | Cria sessão, retorna URL do QR code |
| `GET` | `/auth/logout` | `?sessionName=&email=` query | Encerra e limpa sessão |
| `GET` | `/auth/sessions` | `?email=` query | Lista sessões do usuário no banco |
| `GET` | `/auth/preference-numbers` | `?email=` query | Números WhatsApp associados ao email |
| `GET` | `/auth/statusfinder` | `?email=` query | Último acesso registrado no log |

**Fluxo de login:**
```
POST /auth/login
  ├─ Deleta perfil Chromium antigo + token WPP
  ├─ wppconnect.create() com catchQR callback
  ├─ catchQR → saveQRCode() → broadcast WebSocket {type:"qr"}
  ├─ onStateChange → attachStateListener()
  ├─ onMessage → attachMessageListener()
  └─ SESSIONS.set(name, {client, myNumber, email})
```

---

### Agentes/Bots (`routes/agents.js`)

| Método | Endpoint | Parâmetros | Descrição |
|--------|----------|------------|-----------|
| `GET` | `/api/agents` | `?email=` query | Lista todos os agentes do usuário |
| `POST` | `/api/agents` | `?email=` + body JSON | Cria novo agente |
| `PUT` | `/api/agents/:id` | `?email=` + body JSON | Atualiza agente existente |
| `DELETE` | `/api/agents/:id` | `?email=` query | Remove agente |
| `POST` | `/api/agents/:id/fire` | `?email=` query | Dispara bot imediatamente (ignora cron) |
| `POST` | `/api/agents/test-run` | `{message, email}` body | Teste com sessão ativa |

**Armazenamento dos agentes:** arquivos JSON em `data/agents/{email}.json` — cada arquivo é um array de objetos de agente.

---

### Mensagens (`routes/messages.js`)

| Método | Endpoint | Parâmetros | Descrição |
|--------|----------|------------|-----------|
| `POST` | `/send-text` | `{sessionName, to, text}` body | Envia mensagem de texto via sessão ativa |

```bash
# Exemplo
curl -X POST http://localhost:8443/send-text \
  -H "Content-Type: application/json" \
  -d '{"sessionName":"5511999999999","to":"5511888888888@c.us","text":"Olá!"}'
```

---

### Dispositivos (`routes/devices.js`)

| Método | Endpoint | Parâmetros | Descrição |
|--------|----------|------------|-----------|
| `GET` | `/statusdevices` | `?email=` query | Status de sessões + último acesso (join com logs) |

**Resposta:**
```json
[{
  "numero": "5511999999999",
  "status": "CONNECTED",
  "ultimo_acesso": "2026-05-10T14:30:00",
  "duracao_segundos": 3600,
  "total_transcricoes": 42
}]
```

---

### Usuários (`routes/usuarios.js`)

| Método | Endpoint | Parâmetros | Descrição |
|--------|----------|------------|-----------|
| `POST` | `/api/user/register` | `{email, senha}` body | Cadastra usuário (scrypt hash) |
| `POST` | `/api/user/login` | `{email, senha}` body | Autentica usuário (timing-safe compare) |

---

### Admin (`routes/admin.js`)

| Método | Endpoint | Parâmetros | Descrição |
|--------|----------|------------|-----------|
| `GET` | `/api/admin/stats` | `?key=ADMIN_KEY` ou header `x-admin-key` | Métricas globais da plataforma |

**Resposta:**
```json
{
  "summary": {
    "totalUsuarios": 120,
    "onlineNow": 14,
    "totalSessoes": 87,
    "totalMinutos": 4320,
    "totalTranscricoes": 1840
  },
  "users": [...],
  "sessions": [...]
}
```

---

### RAG (`routes/rag.js`)

| Método | Endpoint | Parâmetros | Descrição |
|--------|----------|------------|-----------|
| `GET` | `/api/rag/:agentId/stats` | `?email=&session=` query | Contagem de docs e chunks |
| `GET` | `/api/rag/:agentId/docs` | `?email=&session=` query | Lista documentos com metadados |
| `POST` | `/api/rag/:agentId/upload` | `?email=&session=` + multipart | Upload e embedding de documento |
| `DELETE` | `/api/rag/:agentId/docs` | `?email=&session=&filename=` | Remove documento da base |
| `POST` | `/api/rag/:agentId/query` | `{email, session, query, topK}` body | Busca semântica na base |

---

## Funções Principais

### `services/session.js`

| Função | Descrição |
|--------|-----------|
| `cleanupSession(name)` | Logout WPP, remove de SESSIONS, deleta tokens/perfil, atualiza DB |
| `attachStateListener(client, name, email)` | Monitora CONNECTED, DISCONNECTED, OFFLINE; reinicia se necessário |
| `attachMessageListener(client, name)` | Roteador principal de mensagens: texto → agentes; áudio → transcrição |
| `startStatusPolling(name)` | Polling a cada 30s para detectar desconexão silenciosa |
| `restartSessionIfOffline(name, email)` | Recria sessão usando token persistido (sem novo QR) |
| `restoreSession({name, email})` | Restaura sessão existente a partir do FileTokenStore |
| `restoreSessions()` | Boot: restaura até 3 sessões simultaneamente de todas persistidas no DB |

**Diagrama de estados da sessão:**
```
[INIT] ──wppconnect.create()──► [QR gerado] ──QR escaneado──► [CONNECTED]
                                                                    │
                                           DISCONNECTED/CONFLICT ◄──┤
                                                    │               │
                                              cleanupSession()   polling 30s
                                                                    │
                                                               OFFLINE ──► restartSessionIfOffline()
```

---

### `services/agentProcessor.js`

| Função | Descrição |
|--------|-----------|
| `processMessage(sessionName, email, from, text)` | Ponto de entrada: seleciona agente, gerencia conversa |
| `startConversation(sessionName, email, agentId, from, text)` | Inicia nova conversa, registra em `activeConversations` |
| `continueConversation(conv, sessionName, text, from)` | Continua turno existente, checa timeout e maxTurns |
| `collectField(conv, sessionName, text, from)` | Coleta campo obrigatório (date, number, text, uppercase) |
| `callEndpoint(agent, collectedFields, message)` | HTTP GET/POST com substituição de placeholders no template |
| `formatWithAI(prompt, endpointData, userMessage)` | Chama OpenAI com prompt do sistema + dados do endpoint |
| `endConversation(key, sessionName, from, agent)` | Envia mensagem de encerramento, remove de activeConversations |

**Estado de conversas ativas:**
```javascript
activeConversations: Map<"sessionName::contactJID" → {
  agentId,        // ID do agente em uso
  email,          // e-mail do dono da sessão
  turns,          // número de trocas realizadas
  startedAt,      // timestamp de início
  lastActivity,   // timestamp da última mensagem
  collectedFields,// {campo: valor} coletados
  awaitingField,  // campo pendente de coleta
  isScheduled,    // true se iniciada pelo bot agendado
  scheduledContact// JID do contato (bots agendados)
}>
```

**Fluxo de processamento de mensagem:**
```
attachMessageListener recebe texto
         │
         ├─ Conversa existente? ──► continueConversation()
         │                               │
         │                         awaitingField? ──► collectField()
         │                               │
         │                         endKeyword? ──► endConversation()
         │                               │
         │                         maxTurns atingido? ──► endConversation()
         │                               │
         │                         callEndpoint() ──► formatWithAI() ──► reply
         │
         └─ Keyword match? ──► startConversation()
                  │
            requiredFields? ──► pergunta o primeiro campo
                  │
            nenhum campo? ──► callEndpoint() ──► formatWithAI() ──► reply
```

---

### `services/botScheduler.js`

| Função | Descrição |
|--------|-----------|
| `loadAndSchedule()` | Lê todos os arquivos de agentes, agenda crons válidos |
| `scheduleAgent(agent, sessionName, email)` | Cria tarefa cron com node-cron (fuso: America/Sao_Paulo) |
| `fireAgent(agent, sessionName, email)` | Executa disparo: envia mensagem + inicia conversa agendada |
| `refreshSchedules()` | Cancela todos e reagenda (chamado após CRUD de agente) |

---

### `services/audio.js`

| Função | Descrição |
|--------|-----------|
| `transcribeAudio(msgData, client, myNumber)` | Orquestra todo o pipeline de transcrição |
| `decryptAudio(msgData)` | Descriptografa arquivo de áudio WhatsApp |
| `applyNoiseReduction(inputPath)` | FFmpeg: filtro `afftdn` → `_clean.ogg` |
| `transcribeLocal(audioPath)` | Executa Whisper local com `WHISPER_MODEL` |
| `transcribeViaAPI(audioPath)` | Fallback: OpenAI Whisper API (`whisper-1`) |
| `sendTranscription(client, dest, text)` | Envia texto transcrito ao destinatário configurado |

---

### `services/ragProcessor.js`

| Função | Descrição |
|--------|-----------|
| `processDocument(email, session, agentId, filename, text)` | Divide em chunks (1200 chars, overlap 200), gera embeddings, persiste |
| `retrieveContext(email, session, agentId, query, topK)` | Embeda query, cosine similarity, retorna top-K acima do threshold 0.25 |
| `listDocuments(email, session, agentId)` | Agrupa chunks por `source`, retorna lista com contagem |
| `deleteDocument(email, session, agentId, filename)` | Remove todos os chunks do documento |
| `ragStats(email, session, agentId)` | Conta total de docs e chunks |

**Caminho de armazenamento:** `data/rag/{email}/{session}/{agentId}/embeddings.json`

---

## Funções Auxiliares (`utils/helpers.js`)

| Função | Descrição |
|--------|-----------|
| `extractPhoneNumberInfo(sender)` | Extrai DDI, timezone, formata número a partir do JID `@c.us` |
| `normalizeToWhatsAppNumber(formatted)` | Limpa e adiciona `@c.us` ao número formatado |
| `enqueueProcessing(sessionName, fn)` | Serializa processamento assíncrono por sessão via Promise chain |
| `saveQRCode(base64Qr, sessionName)` | Decodifica base64, salva PNG em `temp/`, retorna caminho relativo |
| `getAudioDuration(inputPath)` | Usa `ffprobe` para medir duração em segundos |

**DDI → Fuso horário mapeado em `constants.js`:**

| DDI | País | Fuso |
|-----|------|------|
| 55 | Brasil | America/Sao_Paulo |
| 1 | EUA/Canadá | America/New_York |
| 351 | Portugal | Europe/Lisbon |
| 44 | Reino Unido | Europe/London |
| 34 | Espanha | Europe/Madrid |

---

## Tipos de Bots e Funcionamento

### 1. Bot de Resposta por Keyword (Padrão)

Ativado quando a mensagem do contato contém uma das palavras-chave configuradas.

```
Contato envia: "quero ver imóveis"
      │
keyword match: "imóvel" ─► agente ativado
      │
Coleta campos obrigatórios (se configurados)
      │
Chama endpoint externo (GET/POST)
      │
Formata resposta com OpenAI + prompt
      │
Responde ao contato
```

**Configuração mínima:**
- `keywords`: palavras-chave separadas por vírgula (ou `*` para tudo)
- `endpoint`: URL da API de dados
- `prompt`: instrução da IA para formatar a resposta

---

### 2. Bot RAG (Base de Conhecimento)

Usa documentos carregados na base interna ao invés de endpoint externo.

```
Contato envia: "qual o prazo de entrega?"
      │
keyword match ─► agente RAG ativado
      │
Query embedded (OpenAI text-embedding-3-small)
      │
Cosine similarity nos embeddings armazenados
      │
Top-K trechos relevantes (threshold ≥ 0.25)
      │
Trechos + prompt ─► OpenAI GPT ─► resposta
```

**Configuração:**
- `ragEnabled: true`
- `ragTopK`: número de trechos por consulta (padrão: 5)
- `ragNoDataMessage`: mensagem quando não há resultado
- Documentos: `.txt`, `.md`, `.csv`, `.json`, `.html` (máx. 2MB)

---

### 3. Bot Agendado (Cobrança / Proativo)

Dispara mensagens automáticas em horários definidos por expressão cron.

```
Cron dispara (ex: 09:00 Seg–Sex)
      │
Envia `message` para cada contato em `contacts`
      │
Registra conversa em activeConversations
      │
Contato responde ─► continua como bot normal
      │
Conversa encerra ─► envia self-message (resumo)
                    ao número da sessão
```

**Configuração:**
- `scheduledBot.enabled: true`
- `scheduledBot.cronExpr`: expressão cron (fuso: America/Sao_Paulo)
- `scheduledBot.message`: mensagem inicial enviada
- `scheduledBot.contacts`: lista de JIDs (`55XXXXXXXXXXX@c.us`)
- `scheduledBot.selfMessageTemplate`: template do resumo enviado ao operador

---

### 4. Bot Híbrido (Keyword + Agendado)

Combinação dos tipos 1 e 3: o mesmo agente responde a keywords organicamente **e** dispara proativamente pelo cron.

---

## Vínculo de Sessões

Uma sessão é a conexão de um número WhatsApp à plataforma. O vínculo segue esta hierarquia:

```
Usuário (email)
    └── Sessão (número WhatsApp) — vinculada via SESSIONS Map + DB sessoes
            └── Agente (bot) — vinculado por email no arquivo JSON
                    └── Conversa — vinculada por "sessionName::contactJID"
                            └── RAG — vinculado por (email/sessão/agentId)
```

### Como o vínculo é mantido

**Em memória (`state.js`):**
```javascript
SESSIONS.set("5511999999999", {
  client,          // instância WPPConnect
  myNumber,        // número autenticado (JID)
  email            // dono da sessão
});
```

**No banco (`sessoes`):**
```sql
INSERT IGNORE INTO sessoes (numero, usuario_email, status)
VALUES ('5511999999999', 'usuario@email.com', 'CONNECTED');
```

**Fluxo de vínculo ao receber mensagem:**
```
Mensagem chega na sessão "5511999999999"
      │
SESSIONS.get("5511999999999") → {client, myNumber, email}
      │
email → carregar agentes do arquivo data/agents/{email}.json
      │
Verificar keyword match → selecionar agente
      │
activeConversations.get("5511999999999::5511888888888@c.us") → estado da conversa
```

### Restauração automática no boot

```javascript
// services/session.js — restoreSessions()
// 1. Busca sessões no banco com status CONNECTED
// 2. Verifica se token WPP existe em tokens/
// 3. Recria até 3 sessões em paralelo (sem novo QR)
// 4. Reanexa listeners de estado e mensagem
```

---

## WebSocket — Comunicação em Tempo Real

**Endpoint:** `ws://localhost:8443` (ou `wss://` em produção)

### Mensagens do cliente para o servidor

```json
{ "type": "requestQR", "sessionName": "5511999999999" }
```

### Mensagens do servidor para o cliente

| `type` | Campos adicionais | Descrição |
|--------|------------------|-----------|
| `qr` | `sessionName`, `qrPath` | Novo QR code disponível para leitura |
| `authenticated` | `sessionName` | Sessão autenticada com sucesso |
| `qrReadSuccess` | `session`, `success: true` | QR foi escaneado pelo celular |

### Implementação no frontend (painel)

```javascript
const ws = new WebSocket('wss://seudominio.com.br');
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.type === 'qr' && msg.sessionName === currentSession) {
    qrImg.src = msg.qrPath + '?t=' + Date.now();
  }
  if (msg.type === 'authenticated') {
    // exibe overlay de sucesso
  }
};
ws.onopen = () => ws.send(JSON.stringify({
  type: 'requestQR',
  sessionName: '5511999999999'
}));
```

---

## Fluxo de Áudio e Transcrição

```
Mensagem de áudio/PTT recebida pelo listener
         │
         ▼
enqueueProcessing(sessionName, fn)   ← serializa por sessão
         │
         ▼
decryptAudio() → salva como .ogg
         │
         ▼
FFmpeg: afftdn noise reduction → _clean.ogg
         │
         ▼
getAudioDuration() ← ffprobe mede duração
         │
         ▼
transcribeLocal(WHISPER_MODEL)
         │  falhou?
         ▼
transcribeViaAPI() ← OpenAI whisper-1 (fallback)
         │
         ▼
sendTranscription()
  ├─ TRANSCRIPTION_DESTINATION=self → envia ao myNumber (operador)
  └─ TRANSCRIPTION_DESTINATION=sender → envia de volta ao remetente
         │
         ▼
saveSessionLog() → logs_sessao (email, sessao, duracao, transcricoes++)
```

**Variáveis de ambiente relevantes:**

| Variável | Valores | Padrão |
|----------|---------|--------|
| `WHISPER_MODEL` | tiny / base / small / medium / large | `small` |
| `TRANSCRIPTION_DESTINATION` | `self` / `sender` | `self` |
| `OPENAI_API_KEY` | `sk-...` | obrigatório para fallback |

---

## RAG — Base de Conhecimento

### Indexação de documento

```
POST /api/rag/:agentId/upload
         │
   Lê texto do arquivo (máx. 2MB)
         │
   Divide em chunks (1200 chars, overlap 200)
         │
   Para cada chunk:
     openai.embeddings.create({
       model: "text-embedding-3-small",
       input: chunk
     })
         │
   Salva em embeddings.json:
     [{id, source, text, embedding:[...floats], createdAt}]
```

### Consulta semântica

```
Pergunta do usuário
         │
   openai.embeddings.create(query)
         │
   Para cada chunk em embeddings.json:
     score = cosineSimilarity(queryEmbedding, chunkEmbedding)
         │
   Filtra score ≥ 0.25
   Ordena por score desc
   Retorna top-K chunks
         │
   Injeta no prompt:
     "Contexto: [trecho1]\n[trecho2]..."
```

---

## Bot Agendado (Scheduler)

### Expressões Cron — Referência Rápida

| Expressão | Significado |
|-----------|-------------|
| `0 9 * * 1-5` | Seg–Sex às 9h00 |
| `0 9 * * *` | Todo dia às 9h00 |
| `0 9,18 * * 1-5` | Seg–Sex às 9h e 18h |
| `0 */2 * * *` | A cada 2 horas |
| `*/30 * * * *` | A cada 30 minutos |

**Formato:** `minuto hora dia-do-mês mês dia-da-semana`

### Placeholders do Self-Message Template

| Placeholder | Valor |
|-------------|-------|
| `{{contact}}` | Número do contato (`55XXXXXXXXXXX@c.us`) |
| `{{date}}` | Data e hora da interação |
| `{{session}}` | Nome da sessão |
| `{{agentName}}` | Nome do agente |
| `{{nome_do_campo}}` | Qualquer campo coletado via `requiredFields` |

---

## Segurança

| Camada | Implementação |
|--------|---------------|
| HTTPS/TLS | config/https.js com certificado em produção |
| Helmet | CSP, X-Frame-Options, HSTS, XSS-Protection |
| CORS | Whitelist por `CORS_ORIGIN` |
| Senhas | scrypt + salt 16 bytes + timing-safe compare |
| Admin | Header `x-admin-key` ou query `?key=` com `ADMIN_KEY` |
| Sessões | Isolamento por email; tokens persistidos localmente |
| Injeção | Sem eval; templates com substituição simples de strings |

---

## Executando o Servidor

```bash
# Desenvolvimento (HTTP)
node server.js

# Produção (HTTPS — necessita certificados em config/https.js)
NODE_ENV=production node server.js

# Com PM2 (recomendado para produção)
pm2 start server.js --name zapcomander
pm2 save
pm2 startup
```

### Tecnologias e Dependências Principais

| Pacote | Versão | Função |
|--------|--------|--------|
| `@wppconnect-team/wppconnect` | ^1.41.3 | Automação WhatsApp Web |
| `express` | ^4.21.2 | Framework HTTP |
| `ws` | — | WebSocket server |
| `mysql2` | ^3.22.3 | Driver MySQL com Pool |
| `openai` | ^4.89.0 | GPT + Whisper + Embeddings |
| `node-cron` | ^4.2.1 | Agendamento de bots |
| `puppeteer` | ^24.4.0 | Chromium headless (WPP) |
| `luxon` | ^3.6.1 | Datas e fusos horários |
| `helmet` | ^8.1.0 | Headers de segurança HTTP |
| `axios` | ^1.8.4 | HTTP client para endpoints |
| `qrcode` | ^1.5.4 | Geração de QR PNG |
| `dotenv` | ^16.6.1 | Variáveis de ambiente |
| `jsonwebtoken` | ^9.0.2 | JWT (reservado) |
| `natural` | ^8.0.1 | NLP (processamento de texto) |
