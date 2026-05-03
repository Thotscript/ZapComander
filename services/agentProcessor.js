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

// Limpeza periódica de conversas expiradas (a cada 5 min)
setInterval(() => {
  const now    = Date.now();
  const agents = loadAgents();
  for (const [key, conv] of activeConversations.entries()) {
    const agent       = agents.find(a => a.id === conv.agentId);
    const timeoutMs   = (parseInt(agent?.sessionTimeout) || 15) * 60_000;
    if (now - conv.lastActivity > timeoutMs) {
      activeConversations.delete(key);
      console.log(`⏰ Conversa expirada por inatividade: ${key}`);
    }
  }
}, 5 * 60_000);

function matchesKeywords(keywords, text) {
  const lower = text.toLowerCase();
  const kws   = (keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  return kws.includes('*') || kws.some(kw => kw && lower.includes(kw));
}

function matchesAgent(agent, text) {
  if (!agent.active) return false;
  return matchesKeywords(agent.keywords, text);
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
      agentId:      agent.id,
      turns:        1,
      startedAt:    Date.now(),
      lastActivity: Date.now(),
    });
    console.log(`🆕 [${sessionName}] Nova conversa com ${from} | agente: ${agent.name}`);
  }

  const session = SESSIONS.get(sessionName);
  if (!session?.client) {
    console.warn(`⚠️  [${sessionName}] Sessão ausente no SESSIONS map.`);
    return false;
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
      bodyStr = bodyStr
        .replace(/\{\{message\}\}/g, messageText.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
        .replace(/\{\{session\}\}/g, sessionName);
      const { data } = await axios({ method, url: agent.endpoint, data: JSON.parse(bodyStr), timeout: 10_000 });
      endpointResponse = data;
    }

    const payload = extractByPath(endpointResponse, agent.responsePath);

    // ── Monta prompt e chama Ollama ───────────────────────
    // System: instruções do agente + regra de grounding
    const systemContent = [
      agent.prompt.trim(),
      '',
      'REGRA: Responda EXCLUSIVAMENTE com base nos dados JSON fornecidos abaixo.',
      'Não invente, não acrescente informações externas, não cite fontes que não estejam nos dados.',
      'Se a informação não estiver nos dados, diga apenas que não possui essa informação.',
    ].join('\n');

    // User: dados + pergunta — modelos pequenos seguem o turno user com mais fidelidade
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

    const reply = completion.choices[0].message.content.trim();
    if (!reply) throw new Error('Resposta vazia do LLM');

    await session.client.sendText(from, reply);
    console.log(`✅ Agente "${agent.name}" respondeu para ${from}`);
    return true;
  } catch (err) {
    console.error(`❌ Erro no agente "${agent.name}":`, err.message);
    // Remove conversa em caso de erro para não travar o usuário
    activeConversations.delete(convKey);
    return false;
  }
}
