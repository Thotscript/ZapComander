import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import OpenAI from 'openai';
import { SESSIONS } from '../state.js';

// Lazy — evita instanciar antes do dotenv.config() rodar no server.js
let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
export const AGENTS_FILE = path.join(__dirname, '..', 'data', 'agents.json');

export function loadAgents() {
  try { return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); }
  catch { return []; }
}

export function writeAgents(agents) {
  const dir = path.dirname(AGENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf8');
}

/* ─────────────────────────────────────────────────────────────
   ESTADO DE CONVERSAS ATIVAS
   Chave: `${sessionName}::${from}`
   Valor: { agentId, turns, startedAt, lastActivity }
───────────────────────────────────────────────────────────── */
const activeConversations = new Map();

// Limpeza periódica de conversas expiradas (verifica a cada 1 min)
setInterval(() => {
  const now    = Date.now();
  const agents = loadAgents();
  for (const [key, conv] of activeConversations.entries()) {
    const agent     = agents.find(a => a.id === conv.agentId);
    const timeoutMs = (parseInt(agent?.sessionTimeout) || 5) * 60_000;
    if (now - conv.lastActivity > timeoutMs) {
      activeConversations.delete(key);
      console.log(`⏰ Conversa expirada por inatividade: ${key}`);
    }
  }
}, 60_000);

function matchesKeywords(keywords, text) {
  const lower = text.toLowerCase();
  const kws   = (keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  return kws.includes('*') || kws.some(kw => kw && lower.includes(kw));
}

function matchesAgent(agent, text) {
  if (!agent.active) return false;
  return matchesKeywords(agent.keywords, text);
}

/* Extrai um valor do texto com base no tipo esperado do campo */
function extractFieldValue(type, text) {
  const t = text.trim();
  switch (type) {
    case 'date': {
      const m = t.match(/\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/);
      if (!m) return null;
      const parts = m[1].replace(/-/g, '/').split('/');
      if (parts.length === 2)
        return `${parts[0].padStart(2,'0')}/${parts[1].padStart(2,'0')}/${new Date().getFullYear()}`;
      return m[1].replace(/-/g, '/');
    }
    case 'number': {
      const m = t.match(/\b(\d+)\b/);
      return m ? m[1] : null;
    }
    case 'uppercase':
      return t ? t.toUpperCase() : null;
    default:
      return t || null;
  }
}

function extractByPath(obj, dotPath) {
  if (!dotPath || !dotPath.trim()) return obj;
  return dotPath.trim().split('.').reduce((acc, k) => acc?.[k], obj) ?? obj;
}

async function sendAndClose(client, from, agentId, convKey, reason) {
  const agent  = loadAgents().find(a => a.id === agentId);
  const endMsg = agent?.endMessage?.trim() ||
    'Fico por aqui! Se precisar de mais alguma coisa é só chamar. 😊';
  activeConversations.delete(convKey);
  console.log(`🔚 Conversa encerrada (${reason}): ${convKey}`);
  await client.sendText(from, endMsg).catch(() => {});
}

/* ─────────────────────────────────────────────────────────────
   FUNÇÃO PRINCIPAL
───────────────────────────────────────────────────────────── */
export async function runAgent(sessionName, from, messageText) {
  const convKey  = `${sessionName}::${from}`;
  const agents   = loadAgents();
  const existing = activeConversations.get(convKey);

  let agent;
  let isNewConversation = false;

  if (existing) {
    // ── Conversa em andamento ──────────────────────────────
    agent = agents.find(a => a.id === existing.agentId && a.active);

    if (!agent) {
      // Agente foi desativado/excluído durante a conversa
      activeConversations.delete(convKey);
      return false;
    }

    // Verifica palavra de encerramento
    if (agent.endKeywords && matchesKeywords(agent.endKeywords, messageText)) {
      const session = SESSIONS.get(sessionName);
      if (session?.client) await sendAndClose(session.client, from, agent.id, convKey, 'palavra de encerramento');
      return true;
    }

    // Atualiza contadores
    existing.turns++;
    existing.lastActivity = Date.now();

    // Verifica limite de turnos
    const maxTurns = parseInt(agent.maxTurns) || 0;
    if (maxTurns > 0 && existing.turns > maxTurns) {
      const session = SESSIONS.get(sessionName);
      if (session?.client) await sendAndClose(session.client, from, agent.id, convKey, `máximo de ${maxTurns} turnos`);
      return true;
    }

    console.log(`🔄 [${sessionName}] Turno ${existing.turns} com ${from} | agente: ${agent.name}`);
  } else {
    // ── Nova conversa — verifica keywords ─────────────────
    console.log(`🔍 [${sessionName}] ${agents.length} agente(s) | mensagem: "${messageText.slice(0, 60)}"`);

    agent = agents.find(a => matchesAgent(a, messageText));
    if (!agent) {
      console.log(`⏭️  [${sessionName}] Nenhum agente correspondeu.`);
      return false;
    }

    activeConversations.set(convKey, {
      agentId:         agent.id,
      turns:           1,
      startedAt:       Date.now(),
      lastActivity:    Date.now(),
      collectedFields: {},
      awaitingField:   null,
    });
    isNewConversation = true;
    console.log(`🆕 [${sessionName}] Nova conversa com ${from} | agente: ${agent.name}`);
  }

  const session = SESSIONS.get(sessionName);
  if (!session?.client) {
    console.warn(`⚠️  [${sessionName}] Sessão ausente no SESSIONS map.`);
    return false;
  }

  // ── Coleta de campos obrigatórios (multi-turno) ───────────
  const requiredFields = Array.isArray(agent.requiredFields) ? agent.requiredFields : [];
  const conv = activeConversations.get(convKey);

  if (requiredFields.length > 0) {
    if (isNewConversation) {
      // Tenta extrair date/number da mensagem inicial (ex: "3 quartos de 10/07 a 17/07")
      for (const f of requiredFields) {
        if (['date', 'number'].includes(f.extractType) && !conv.collectedFields[f.name]) {
          const v = extractFieldValue(f.extractType, messageText);
          if (v !== null) conv.collectedFields[f.name] = v;
        }
      }
    } else if (conv.awaitingField) {
      const fDef = requiredFields.find(f => f.name === conv.awaitingField);
      if (fDef) {
        const v = extractFieldValue(fDef.extractType || 'text', messageText);
        if (v !== null) {
          conv.collectedFields[conv.awaitingField] = v;
          conv.awaitingField = null;
          console.log(`📋 Campo "${fDef.name}" = ${v}`);
        } else {
          // Não conseguiu extrair — repergunta
          await session.client.sendText(from, fDef.question);
          return true;
        }
      }
    }

    // Verifica se ainda há campos pendentes
    const missing = requiredFields.find(f => !conv.collectedFields[f.name]);
    if (missing) {
      conv.awaitingField = missing.name;
      await session.client.sendText(from, missing.question);
      return true;
    }
    console.log(`✅ Todos os campos coletados:`, JSON.stringify(conv.collectedFields));
  }

  console.log(`🤖 Agente "${agent.name}" processando | "${messageText.slice(0, 60)}"`);

  try {
    // ── Chama endpoint de dados ────────────────────────────
    const method = (agent.method || 'GET').toUpperCase();
    let endpointResponse;

    if (method === 'GET') {
      const { data } = await axios.get(agent.endpoint, { timeout: 10_000 });
      endpointResponse = data;
    } else {
      let bodyStr = agent.requestTemplate || '{}';
      const fields = conv?.collectedFields || {};

      // 1. Substitui {{message}} e {{session}}
      bodyStr = bodyStr
        .replace(/\{\{message\}\}/g, messageText.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
        .replace(/\{\{session\}\}/g, sessionName);

      // 2. "{{field}}" — contexto string → devolve "" se vazio
      bodyStr = bodyStr.replace(/"{{(\w+)}}"/g, (_, k) => {
        const v = fields[k];
        if (v == null || v === '') return '""';
        return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      });

      // 3. {{field}} — contexto numérico (sem aspas) → devolve 0 se vazio
      bodyStr = bodyStr.replace(/\{\{(\w+)\}\}/g, (_, k) => {
        const v = fields[k];
        if (v == null || v === '') return '0';
        return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      });

      const { data } = await axios({ method, url: agent.endpoint, data: JSON.parse(bodyStr), timeout: 10_000 });
      endpointResponse = data;
    }

    let payload = extractByPath(endpointResponse, agent.responsePath);
    // Limita itens enviados ao LLM (ex: responseLimit: 1 mostra só o primeiro)
    const responseLimit = parseInt(agent.responseLimit) || 0;
    if (responseLimit > 0 && Array.isArray(payload)) payload = payload.slice(0, responseLimit);

    // ── Monta prompt e chama OpenAI ──────────────────────
    const endKwList = (agent.endKeywords || '')
      .split(',').map(k => k.trim()).filter(Boolean);

    const quitInstruction = endKwList.length
      ? `Quando o usuário demonstrar satisfação, agradecimento ou usar qualquer uma destas palavras de encerramento: ${endKwList.join(', ')} — finalize sua resposta adicionando exatamente \\quit na última linha (sem aspas, sem explicação). Esse é um sinal interno que não será exibido ao usuário.`
      : `Quando perceber que a conversa chegou ao fim (agradecimento, despedida, satisfação) — finalize sua resposta adicionando exatamente \\quit na última linha (sem aspas, sem explicação). Esse é um sinal interno que não será exibido ao usuário.`;

    const systemContent = [
      agent.prompt.trim(),
      '',
      'REGRA: Responda EXCLUSIVAMENTE com base nos dados JSON fornecidos abaixo.',
      'Não invente, não acrescente informações externas, não cite fontes que não estejam nos dados.',
      'Se a informação não estiver nos dados, diga apenas que não possui essa informação.',
      '',
      quitInstruction,
    ].join('\n');

    const userContent = [
      'Dados disponíveis:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
      '',
      `Pergunta: ${messageText}`,
    ].join('\n');

    const model = process.env.AGENT_MODEL || 'gpt-4o-mini';
    console.log(`🧠 OpenAI | modelo: ${model}`);

    const completion = await getOpenAI().chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user',   content: userContent   },
      ],
      temperature: 0.3,
      max_tokens:  600,
    });

    const rawReply = completion.choices[0].message.content.trim();
    if (!rawReply) throw new Error('Resposta vazia do LLM');

    // Detecta \quit interno — strip antes de enviar ao usuário
    const shouldQuit = /\\quit\s*$/im.test(rawReply);
    const reply      = rawReply.replace(/\n?\\quit\s*$/im, '').trim();

    await session.client.sendText(from, reply);
    console.log(`✅ Agente "${agent.name}" respondeu para ${from}`);

    if (shouldQuit) {
      // LLM sinalizou fim — encerra sem enviar mensagem extra
      activeConversations.delete(convKey);
      console.log(`🔚 [${sessionName}] Conversa encerrada via \\quit do LLM`);
    }
    return true;
  } catch (err) {
    console.error(`❌ Erro no agente "${agent.name}":`, err.message);
    // Remove conversa em caso de erro para não travar o usuário
    activeConversations.delete(convKey);
    return false;
  }
}
