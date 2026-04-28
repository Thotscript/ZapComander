# Documentação Técnica — Orlando AI Broker

Este documento descreve em detalhes a arquitetura, estrutura de pastas, arquivos e funções do projeto para fins de estudo e manutenção.

---

## Visão Geral da Arquitetura

```
Cliente HTTP/WS
      │
      ▼
  server.js              ← ponto de entrada, monta Express + WebSocket
      │
  ┌───┴──────────────────────────────────┐
  │           Express Routes             │
  │  /auth/*  /statusdevices  /send-text │
  └───┬──────────────────────────────────┘
      │
  ┌───┴─────────────────┐
  │   services/         │
  │   session.js        │  ← ciclo de vida das sessões WPPConnect
  │   audio.js          │  ← pipeline de transcrição de áudio
  └───┬─────────────────┘
      │
  ┌───┴──────────────────────────────────┐
  │  @wppconnect-team/wppconnect         │
  │  Chromium headless + WhatsApp Web    │
  └──────────────────────────────────────┘
      │
  ┌───┴─────┐   ┌──────────┐   ┌──────────────┐
  │  MySQL  │   │ WebSocket│   │ Whisper/FFmpeg│
  └─────────┘   └──────────┘   └──────────────┘
```

---

## Estrutura de Pastas

```
orlando-ai-broker/
├── server.js                  # Entrada da aplicação
├── state.js                   # Estado global em memória
├── .env                       # Variáveis de ambiente
│
├── config/
│   ├── constants.js           # Constantes, caminhos, token store, puppeteer args
│   └── https.js               # Configuração TLS (apenas produção)
│
├── routes/
│   ├── auth.js                # Rotas de autenticação e sessão
│   ├── devices.js             # Rota de status de dispositivos
│   └── messages.js            # Rota de envio de mensagens
│
├── services/
│   ├── session.js             # Lógica de ciclo de vida das sessões
│   └── audio.js               # Pipeline de transcrição de áudio
│
├── ws/
│   └── websocket.js           # Servidor WebSocket
│
├── db/
│   ├── index.js               # Pool de conexões MySQL
│   ├── sessions.js            # Operações de sessão no banco
│   ├── usuarios.js            # Operações de usuário no banco
│   └── logs.js                # Gravação de logs de sessão
│
├── utils/
│   └── helpers.js             # Funções utilitárias compartilhadas
│
├── prompts/
│   └── transcricao.txt        # Prompt do agente de transcrição (legado GPT)
│
├── public/
│   ├── index.html             # Interface web para escanear QR Code
│   └── qrcodes/               # QR Codes gerados (servidos estaticamente)
│
├── tokens/                    # Perfis Chromium e tokens de sessão WPPConnect
├── audios/                    # Arquivos de áudio temporários (.ogg)
└── transcricoes/              # Saída temporária do Whisper (.txt)
```

---

## Arquivos Detalhados

---

### `server.js`

Ponto de entrada da aplicação. Responsável por:

1. Carregar variáveis de ambiente via `dotenv`
2. Criar os diretórios necessários (`tokens/`, `audios/`, `public/qrcodes/`, `sessions_logs/`)
3. Instanciar o servidor HTTP (dev) ou HTTPS (produção)
4. Inicializar o WebSocket server (`initWss`)
5. Registrar middlewares: CORS, JSON, Helmet (CSP), CORS manual, static files
6. Montar os routers: `authRouter`, `devicesRouter`, `messagesRouter`
7. Configurar o WebSocket (`setupWebSocket`)
8. Restaurar sessões persistidas no banco (`restoreSessions`) e então subir o servidor na porta definida

**Decisão importante:** o `await import('./config/https.js')` é feito dinamicamente só em produção para evitar erros ao rodar sem certificado TLS em desenvolvimento.

---

### `state.js`

Armazena o estado volátil da aplicação (em memória, reiniciado a cada restart):

| Exportação | Tipo | Conteúdo |
|-----------|------|----------|
| `SESSIONS` | `Map<string, Session>` | Sessões ativas. Chave = `sessionName`. Valor = `{ client, myNumber, email }` |
| `processingQueues` | `Map<string, Promise>` | Filas de processamento por sessão (garante ordem de mensagens) |
| `RESTARTING_SESSIONS` | `Set<string>` | Sessions em processo de restart (evita loops duplos) |
| `sessionClients` | `Map<string, WebSocket>` | Associa `sessionName` ao cliente WebSocket que solicitou o QR |

---

### `config/constants.js`

Define constantes e configurações usadas em todo o projeto:

| Exportação | Tipo | Descrição |
|-----------|------|-----------|
| `TOKEN_DIR` | `string` | Diretório dos perfis Chromium (`./tokens` em dev, `/root/wpptalk_server/tokens` em prod) |
| `SESSION_LOGS_DIR` | `string` | `TOKEN_DIR/sessions_logs` |
| `QR_CODES_DIR` | `string` | `public/qrcodes` — servido estaticamente |
| `AUDIO_DIR` | `string` | `audios/` — arquivos temporários de áudio |
| `DDI_TO_TIMEZONE` | `object` | Mapa de DDI → timezone IANA (ex: `'55' → 'America/Sao_Paulo'`) |
| `PUPPETEER_ARGS` | `string[]` | Flags do Chromium. Reduzido ao mínimo (`--mute-audio`) para evitar bloqueio de rede |
| `myTokenStore` | `FileTokenStore` | Instância do token store do WPPConnect para persistência de tokens de autenticação |

---

### `routes/auth.js`

Router Express com as rotas de gerenciamento de sessão.

#### `POST /auth/login`

**Body:** `{ sessionName: string, email: string }`

Fluxo:
1. Verifica se a sessão já está ativa em `SESSIONS`
2. **Apaga o perfil Chromium anterior** (`fs.rmSync`) e o token do `FileTokenStore` para forçar novo QR — evita o bug de "Auto Close Called" por sessão expirada em cache
3. Chama `wppconnect.create()` com:
   - `catchQR`: salva o QR como PNG em `QR_CODES_DIR`, retorna a URL na resposta HTTP, e faz broadcast via WebSocket
   - `statusFind`: loga todos os status recebidos; chama `cleanupSession` se `autocloseCalled`
4. Após criação: registra usuário e sessão no banco, obtém o número WID, adiciona a `SESSIONS`
5. Anexa listeners: `attachStateListener`, `attachMessageListener`, `startStatusPolling`

**Resposta:** `{ qrCodeFile: "URL_do_QR" }`

#### `GET /auth/logout`

**Query:** `?sessionName=&email=`

Chama `cleanupSession(sessionName)` e `excluirSessaoPorEmail(email, sessionName)`.

#### `GET /auth/preference-numbers`

**Query:** `?email=`

Retorna todos os números (sessões) vinculados ao email: `SELECT numero FROM sessoes WHERE usuario_email = ?`

#### `GET /auth/statusfinder`

**Query:** `?email=`

Retorna o registro mais recente de `logs_sessao` para o email (último acesso e número).

---

### `routes/devices.js`

#### `GET /statusdevices`

**Query:** `?email=`

JOIN entre `sessoes` e `logs_sessao`: retorna todos os números do usuário com a data do último acesso, ordenados por atividade mais recente.

---

### `routes/messages.js`

#### `POST /send-text`

**Body:** `{ sessionName: string, to: string, text: string }`

Busca o `client` em `SESSIONS` e chama `client.sendText(to, text)`. O `to` deve estar no formato `5511999999999@c.us`.

---

### `services/session.js`

Núcleo do gerenciamento de sessões. Todas as funções são exportadas e usadas por `routes/auth.js` e pelo próprio serviço.

#### `cleanupSession(sessionName)`

Remove uma sessão de forma completa:
1. Tenta `client.logout()` e `client.close()` se a página ainda estiver aberta
2. Remove de `SESSIONS`
3. Deleta o arquivo QR Code correspondente
4. Remove o diretório do perfil Chromium após 3s (delay para evitar race condition com o Chromium)
5. Deleta o registro `sessoes` no banco

#### `attachStateListener(client, sessionName, email)`

Registra `client.onStateChange()` para reagir a mudanças de estado do WhatsApp:

| Estado | Ação |
|--------|------|
| `CONNECTED` / `MAIN` | Atualiza `myNumber`, persiste sessão no banco, faz broadcast `authenticated` via WS |
| `DISCONNECTED` / `CLOSE` / `UNPAIRED` / `CONFLICT` | Chama `cleanupSession` |
| `OFFLINE` | Chama `restartSessionIfOffline` |

#### `attachMessageListener(client, sessionName)`

Registra `client.onAnyMessage()`. Filtra mensagens:
- Ignora mensagens enviadas pelo próprio número (`message.from === myNumber`)
- Ignora mensagens de grupo (`message.isGroupMsg`)
- Para `ptt` e `audio`: encaminha para `enqueueProcessing → processAudio`

#### `startStatusPolling(sessionName)`

A cada 30 segundos: consulta `client.getConnectionState()` e persiste o status no banco via `atualizarStatusSessao`.

#### `restartSessionIfOffline(sessionName, email)`

Usa `RESTARTING_SESSIONS` como guard para evitar restarts duplos. Aguarda 2s após o cleanup e chama `restoreSession`.

#### `restoreSession({ sessionName, email })`

Recria uma sessão a partir de token persistido (sem gerar novo QR). Usada na restauração automática no boot. Remove `SingletonLock` antes de criar. Não configura `catchQR` pois espera que o token ainda seja válido.

#### `restoreSessions()`

Consultada no boot: lê todas as sessões da tabela `sessoes` e as restaura com concorrência máxima de 3 simultâneas.

---

### `services/audio.js`

Pipeline de processamento de mensagens de áudio.

#### `transcreverComWhisperLocal(audioPath)` (função interna)

Executa o binário `whisper` via `execFile` com:
- Modelo: `WHISPER_MODEL` (env var, padrão `small`)
- Idioma: `pt`
- Formato de saída: `txt`
- Diretório de saída: `transcricoes/`

Após execução, lê o arquivo `.txt` gerado (nome baseado no arquivo de entrada), retorna o texto e deleta o arquivo temporário.

**Timeout:** 300 segundos.

#### `processAudio(sessionName, message)`

Pipeline completo:

```
1. Obtém client e myNumber de SESSIONS
2. Descriptografa o arquivo de áudio (client.decryptFile)
3. Salva como .ogg em audios/
4. FFmpeg: aplica filtro afftdn (redução de ruído adaptativa) → gera arquivo _clean.ogg
   └── Se FFmpeg falhar: copia arquivo original como fallback
5. Mede duração com fluent-ffmpeg (getAudioDuration)
6. Tenta transcrição com Whisper local
   └── Se falhar: tenta API OpenAI whisper-1
7. Envia transcrição diretamente ao remetente (client.sendText com quotedMsg)
8. Remove arquivos temporários de áudio
9. Grava log em logs_sessao via saveSessionLog
```

---

### `ws/websocket.js`

#### `initWss(server)`

Cria o `WebSocket.Server` anexado ao servidor HTTP/HTTPS. Chamado antes de qualquer rota.

#### `setupWebSocket()`

Registra handlers no WSS:
- `connection`: quando um cliente conecta
- `message`: processa mensagens JSON recebidas
  - `type: 'requestQR'`: associa o WebSocket ao `sessionName` em `sessionClients` e faz broadcast imediato do QR atual
- `close`: remove o cliente de `sessionClients`

#### `broadcastQR(sessionName)`

Envia para **todos** os clientes WebSocket conectados:
```json
{ "type": "qr", "sessionName": "...", "qrPath": "/qrcodes/qrcode_....png?t=timestamp" }
```
O parâmetro `?t=timestamp` força o browser a recarregar a imagem em vez de usar cache.

#### `broadcastSessionAuthenticated(sessionName)`

Envia para **todos** os clientes WebSocket:
```json
{ "type": "authenticated", "sessionName": "..." }
```
Disparado quando `onStateChange` recebe `CONNECTED` ou `MAIN`.

---

### `db/index.js`

Pool de conexões MySQL2 com:
- Host: `127.0.0.1`, Porta: `3307`
- Database: `wpptalk_db`, User: `wpptalk`
- `connectionLimit: 10`, charset `utf8mb4`

---

### `db/sessions.js`

| Função | SQL | Descrição |
|--------|-----|-----------|
| `criarOuIgnorarSessao(numero, email)` | `INSERT ... ON DUPLICATE KEY UPDATE` | Insere sessão sem erro se já existir |
| `atualizarStatusSessao(sessionName, status)` | `UPDATE sessoes SET status = ?` | Atualiza status da sessão |
| `excluirSessaoPorEmail(email, sessionName)` | Transação: DELETE filtros + DELETE sessoes | Remove sessão e dados relacionados com rollback em caso de erro |

---

### `db/usuarios.js`

| Função | SQL | Descrição |
|--------|-----|-----------|
| `criarOuIgnorarUsuario(email, plano, limite)` | `INSERT ... ON DUPLICATE KEY UPDATE` | Cria usuário com plano `free` e limite `0` por padrão |

---

### `db/logs.js`

#### `saveSessionLog({ email, sessaoNumero, whatsappNumero })`

1. Extrai o DDI do número WhatsApp para determinar o timezone
2. Formata o timestamp no fuso horário local do contato (via `luxon`)
3. Grava em `logs_sessao` com `ON DUPLICATE KEY UPDATE` (upsert)

---

### `utils/helpers.js`

#### `extractPhoneNumberInfo(sender)`

Recebe `"5511999999999@c.us"`, retorna `{ numeroLimpo, ddi, timezone, numeroFormatado }`. Tenta DDI de 3, 2 e 1 dígitos contra o mapa `DDI_TO_TIMEZONE`.

#### `normalizeToWhatsAppNumber(formatted)`

Remove todos os caracteres não numéricos e adiciona `@c.us`. Ex: `"+55 (11) 99999-9999"` → `"5511999999999@c.us"`.

#### `enqueueProcessing(sessionName, fn)`

Serializa chamadas assíncronas por sessão usando encadeamento de Promises. Garante que mensagens de áudio de uma mesma sessão sejam processadas uma de cada vez, na ordem de chegada.

#### `saveQRCode(base64Qr, sessionName)`

Decodifica um base64 PNG e salva em `public/qrcodes/qrcode_{sessionName}.png`. Retorna o caminho do arquivo.

#### `getAudioDuration(inputPath)`

Usa `fluent-ffmpeg.ffprobe` para retornar a duração em segundos de um arquivo de áudio.

---

### `public/index.html`

Interface web mínima para autenticação via QR Code:

- Conecta ao WebSocket via `wss://` (URL configurada manualmente no código)
- Ao conectar, envia `requestQR` para receber o QR atual
- Exibe a imagem do QR Code e atualiza quando chega novo `type: 'qr'`
- Tenta reconexão automática após 3s se a conexão WS cair

> **Atenção:** o `sessionName` e `NGROK_URL` estão hardcoded no arquivo. Para uso em produção, parametrize via query string ou config.

---

## Fluxo Completo — Login de Sessão

```
1. POST /auth/login { sessionName, email }
         │
2. Limpa perfil Chromium + token FileStore
         │
3. wppconnect.create()
         │
4. Chromium abre, navega para web.whatsapp.com
         │
5. WA-JS (wapi.js) é injetado
         │
6. WhatsApp Web mostra QR → catchQR() chamado
         │
7. QR salvo como PNG em public/qrcodes/
         │
8. Resposta HTTP enviada com URL do QR
         │
9. broadcastQR() → todos os WS clients recebem o caminho
         │
10. Usuário escaneia QR com o celular
         │
11. statusFind('qrReadSuccess') → WS notifica o client específico
         │
12. onStateChange('CONNECTED') → session salva no banco
         │
13. broadcastSessionAuthenticated() → todos os WS clients notificados
```

---

## Variáveis de Ambiente Completas

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `OPENAI_API_KEY` | — | Chave API OpenAI (fallback Whisper) |
| `PORT` | — | Porta do servidor |
| `SECRET_TOKEN` | — | Token interno de segurança |
| `NODE_ENV` | `development` | `development` (HTTP) ou `production` (HTTPS) |
| `BASE_URL` | `https://verbai.com.br:8443` | Base URL para links de QR Code |
| `CORS_ORIGIN` | — | Origem permitida no CORS |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | Endpoint OpenAI-compatible do LM Studio |
| `LMSTUDIO_MODEL` | `local-model` | Identificador do modelo carregado no LM Studio |
| `WHISPER_MODEL` | `small` | Modelo Whisper local (`tiny`/`base`/`small`/`medium`/`large`) |
