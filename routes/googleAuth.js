import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const TOKENS_DIR = path.join(__dirname, '..', 'data', 'google-tokens');

function safeEmail(email) { return email.replace(/[^a-z0-9._-]/gi, '_'); }
function tokensFile(email) { return path.join(TOKENS_DIR, `${safeEmail(email)}.json`); }

function loadTokens(email) {
  try { return JSON.parse(fs.readFileSync(tokensFile(email), 'utf8')); }
  catch { return null; }
}

function saveTokens(email, tokens) {
  if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });
  fs.writeFileSync(tokensFile(email), JSON.stringify(tokens, null, 2), 'utf8');
}

function makeOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL}/api/google/callback`
  );
  if (tokens) client.setCredentials(tokens);
  return client;
}

/* ── AUTH URL ── */
router.get('/api/google/auth-url', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET não configurados no servidor' });

  const url = makeOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: Buffer.from(email).toString('base64'),
  });
  res.json({ url });
});

/* ── OAUTH CALLBACK ── */
router.get('/api/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0d0d0f;color:#e06060;padding:32px">
      <p>Acesso negado: ${error}</p>
      <script>setTimeout(()=>window.close(),2500)</script></body></html>`);
  }
  if (!code || !state) return res.status(400).send('Parâmetros inválidos');

  let email;
  try { email = Buffer.from(state, 'base64').toString('utf8'); }
  catch { return res.status(400).send('Estado inválido'); }

  try {
    const client = makeOAuth2Client();
    const { tokens } = await client.getToken(code);
    saveTokens(email, tokens);
    console.log(`✅ Google Agenda conectado para: ${email}`);

    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Conectado</title>
<style>
  body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;
    background:#0d0d0f;font-family:sans-serif;color:#e8e8ea;}
  .box{text-align:center;padding:40px 32px;}
  .icon{font-size:52px;margin-bottom:16px;}
  .ok{color:#40c070;font-size:1.1rem;font-weight:700;margin-bottom:8px;}
  .sub{color:#6060a0;font-size:.82rem;}
</style></head><body>
<div class="box">
  <div class="icon">✅</div>
  <div class="ok">Google Agenda conectado com sucesso!</div>
  <div class="sub">Esta janela será fechada automaticamente...</div>
</div>
<script>
  try { window.opener && window.opener.postMessage({ type: 'google-auth-success', email: ${JSON.stringify(email)} }, '*'); }
  catch(e) {}
  setTimeout(() => window.close(), 1500);
</script>
</body></html>`);
  } catch (err) {
    console.error('Erro Google OAuth callback:', err.message);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0d0d0f;color:#e06060;padding:32px">
      <p>Erro ao conectar: ${err.message}</p>
      <script>setTimeout(()=>window.close(),4000)</script></body></html>`);
  }
});

/* ── STATUS ── */
router.get('/api/google/status', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });
  res.json({ connected: !!loadTokens(email) });
});

/* ── DISCONNECT ── */
router.delete('/api/google/disconnect', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });
  try { fs.unlinkSync(tokensFile(email)); } catch {}
  res.json({ ok: true });
});

/* ── CALENDAR QUERY (endpoint para o bot usar via POST) ──
   O bot faz POST aqui com os campos coletados no body.
   Retorna os eventos do dia informado (campo "data", "date", "dia" ou "quando").
   Exemplo de requestTemplate do bot:
     { "data": "{{data}}", "periodo": "{{periodo}}" }
──────────────────────────────────────────────────────── */
router.post('/api/google/calendar/query', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });

  const tokens = loadTokens(email);
  if (!tokens) return res.status(401).json({ error: 'Google Agenda não conectado para este usuário.' });

  try {
    const client = makeOAuth2Client(tokens);
    client.on('tokens', (refreshed) => saveTokens(email, { ...tokens, ...refreshed }));

    const calendar = google.calendar({ version: 'v3', auth: client });
    const body = req.body || {};

    // Detecta data nos campos coletados
    const dateRaw = body.data || body.date || body.dia || body.quando || body.Data || '';
    let targetDate = new Date();

    if (dateRaw) {
      const m = String(dateRaw).match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
      if (m) {
        const year = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : new Date().getFullYear();
        targetDate = new Date(`${year}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T12:00:00`);
      } else {
        const parsed = new Date(dateRaw);
        if (!isNaN(parsed)) targetDate = parsed;
      }
    }

    const timeMin = new Date(targetDate); timeMin.setHours(0, 0, 0, 0);
    const timeMax = new Date(targetDate); timeMax.setHours(23, 59, 59, 999);

    const { data } = await calendar.events.list({
      calendarId: 'primary',
      timeMin:     timeMin.toISOString(),
      timeMax:     timeMax.toISOString(),
      singleEvents: true,
      orderBy:     'startTime',
      maxResults:  20,
    });

    const eventos = (data.items || []).map(e => ({
      titulo:    e.summary   || '(sem título)',
      inicio:    e.start?.dateTime || e.start?.date || null,
      fim:       e.end?.dateTime   || e.end?.date   || null,
      local:     e.location  || null,
      descricao: e.description || null,
    }));

    res.json({
      data:         targetDate.toLocaleDateString('pt-BR'),
      totalEventos: eventos.length,
      eventos,
      camposRecebidos: body,
    });
  } catch (err) {
    console.error('Erro Google Calendar query:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── CALENDAR CREATE (endpoint para o bot criar eventos) ──
   Body esperado: { data, horario, titulo, duracao?, descricao? }
   Exemplo de requestTemplate do bot:
     { "data": "{{data}}", "horario": "{{horario}}", "titulo": "{{titulo}}" }
──────────────────────────────────────────────────────────── */
router.post('/api/google/calendar/create', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });

  const tokens = loadTokens(email);
  if (!tokens) return res.status(401).json({ error: 'Google Agenda não conectado para este usuário.' });

  try {
    const client = makeOAuth2Client(tokens);
    client.on('tokens', (refreshed) => saveTokens(email, { ...tokens, ...refreshed }));

    const calendar = google.calendar({ version: 'v3', auth: client });
    const body = req.body || {};

    const dateRaw  = String(body.data   || body.date  || '').trim();
    const timeRaw  = String(body.horario || body.hora  || body.time || '09:00').trim();
    const titulo   = String(body.titulo  || body.title || body.tipo || 'Agendamento').trim();
    const duracao  = Math.max(15, parseInt(body.duracao) || 60);
    const descricao = String(body.descricao || body.observacao || '').trim();

    // Parseia dd/mm/yyyy
    const dm = dateRaw.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
    if (!dm) return res.status(400).json({ error: `Data inválida: "${dateRaw}". Use dd/mm/aaaa.` });
    const year  = dm[3] ? (dm[3].length === 2 ? '20' + dm[3] : dm[3]) : new Date().getFullYear();
    const month = dm[2].padStart(2, '0');
    const day   = dm[1].padStart(2, '0');

    // Parseia HH:MM — aceita "14h", "14:30", "14h30", "9", etc.
    const tm     = timeRaw.replace('h', ':').match(/(\d{1,2})(?::(\d{2}))?/);
    const startH = parseInt(tm?.[1] ?? 9);
    const startM = parseInt(tm?.[2] ?? 0);

    const endTotalMin = startH * 60 + startM + duracao;
    const endH = String(Math.floor(endTotalMin / 60) % 24).padStart(2, '0');
    const endM = String(endTotalMin % 60).padStart(2, '0');

    const startStr = `${year}-${month}-${day}T${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')}:00`;
    const endStr   = `${year}-${month}-${day}T${endH}:${endM}:00`;

    // Verifica conflito antes de criar
    const tzOffset = '-03:00';
    const { data: conflictData } = await calendar.events.list({
      calendarId:   'primary',
      timeMin:      `${startStr}${tzOffset}`,
      timeMax:      `${endStr}${tzOffset}`,
      singleEvents: true,
      maxResults:   5,
    });

    if (conflictData.items?.length > 0) {
      const ocupado = conflictData.items[0];
      const ocupInicio = ocupado.start?.dateTime
        ? new Date(ocupado.start.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
        : '';
      console.log(`⚠️  Conflito de agenda: "${ocupado.summary}" no horário ${startStr}`);
      return res.json({
        sucesso:     false,
        conflito:    true,
        resetField:  'horario',
        mensagem:    `O horário ${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')} já está ocupado com "${ocupado.summary}"${ocupInicio ? ` (às ${ocupInicio})` : ''}. Por favor, escolha outro horário.`,
        horarioOcupado: {
          titulo: ocupado.summary,
          inicio: ocupInicio,
        },
        camposRecebidos: body,
      });
    }

    const { data: event } = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary:     titulo,
        description: descricao,
        start: { dateTime: startStr, timeZone: 'America/Sao_Paulo' },
        end:   { dateTime: endStr,   timeZone: 'America/Sao_Paulo' },
      },
    });

    console.log(`📅 Evento criado no Google Calendar: ${titulo} em ${startStr}`);

    res.json({
      sucesso: true,
      evento: {
        titulo,
        data:   `${day}/${month}/${year}`,
        inicio: `${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')}`,
        fim:    `${endH}:${endM}`,
        link:   event.htmlLink,
      },
      camposRecebidos: body,
    });
  } catch (err) {
    console.error('Erro Google Calendar create:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
