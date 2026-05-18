import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import OpenAI from 'openai';
import { SESSIONS } from '../state.js';
import { retrieveContext, RAG_GUARDRAIL } from './ragProcessor.js';

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const AGENTS_DIR = path.join(__dirname, '..', 'data', 'agents');

function agentsFile(email) {
  const safe = email.replace(/[^a-z0-9._-]/gi, '_');
  return path.join(AGENTS_DIR, `${safe}.json`);
}

export function loadAgents(email) {
  if (!email) return [];
  try { return JSON.parse(fs.readFileSync(agentsFile(email), 'utf8')); }
  catch { return []; }
}

const INDEX_FILE = path.join(AGENTS_DIR, '_index.json');

function loadEmailIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch { return {}; }
}

export function writeAgents(email, agents) {
  if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(agentsFile(email), JSON.stringify(agents, null, 2), 'utf8');
  // Persiste o mapeamento safe-name → email para o scheduler reler após restart
  const safe  = email.replace(/[^a-z0-9._-]/gi, '_');
  const index = loadEmailIndex();
  index[safe] = email;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

/* ─────────────────────────────────────────────────────────────
   ESTADO DE CONVERSAS ATIVAS
   Chave: `${sessionName}::${from}`
   Valor: { agentId, email, turns, startedAt, lastActivity, collectedFields, awaitingField }
───────────────────────────────────────────────────────────── */
export const activeConversations = new Map();

export function startScheduledConversation(sessionName, contact, agentId, email) {
  const convKey = `${sessionName}::${contact}`;
  activeConversations.set(convKey, {
    agentId,
    email,
    turns:           0,
    startedAt:       Date.now(),
    lastActivity:    Date.now(),
    collectedFields: {},
    awaitingField:   null,
    isScheduled:     true,
    scheduledContact: contact,
  });
  console.log(`⏰ Conversa agendada aberta: ${convKey}`);
}

async function sendSelfMessage(sessionName, agent, conv) {
  const template = (agent?.scheduledBot?.selfMessageTemplate || '').trim();
  if (!template || !conv?.isScheduled) return;

  const session = SESSIONS.get(sessionName);
  if (!session?.client || !session.myNumber) return;

  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  let summary = template
    .replace(/\{\{contact\}\}/g, conv.scheduledContact || '')
    .replace(/\{\{date\}\}/g, now)
    .replace(/\{\{session\}\}/g, sessionName)
    .replace(/\{\{agentName\}\}/g, agent.name || '');

  for (const [k, v] of Object.entries(conv.collectedFields || {})) {
    summary = summary.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v ?? '');
  }

  if (!summary.trim()) return;

  // Normaliza para número@c.us — getWid() pode retornar @s.whatsapp.net ou número:device@...
  const rawNumber = String(session.myNumber).split('@')[0].split(':')[0];
  const to = `${rawNumber}@c.us`;

  try {
    await session.client.sendText(to, summary);
    console.log(`📩 Self-message enviada para ${to}`);
  } catch (err) {
    console.error('❌ Erro ao enviar self-message:', err.message);
  }
}

setInterval(async () => {
  const now = Date.now();
  for (const [key, conv] of activeConversations.entries()) {
    const agents    = loadAgents(conv.email);
    const agent     = agents.find(a => a.id === conv.agentId);
    const timeoutMs = (parseInt(agent?.sessionTimeout) || 15) * 60_000;
    if (now - conv.lastActivity > timeoutMs) {
      activeConversations.delete(key);
      console.log(`⏰ Conversa expirada por inatividade: ${key}`);
      const sessionName = key.split('::')[0];
      await sendSelfMessage(sessionName, agent, conv).catch(() => {});
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

function extractFieldValue(type, text) {
  const t = text.trim();
  switch (type) {
    case 'date':
    case 'date_us': {
      const m = t.match(/\b(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)\b/);
      if (!m) return null;
      const parts = m[1].replace(/-/g, '/').split('/');
      let day, month, year;
      if (parts.length === 2) { [day, month] = parts; year = String(new Date().getFullYear()); }
      else                     { [day, month, year] = parts; }
      day   = day.padStart(2, '0');
      month = month.padStart(2, '0');
      return type === 'date_us' ? `${month}/${day}/${year}` : `${day}/${month}/${year}`;
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

async function generateIntroMessage(agent, messageText, firstField) {
  if (!agent.prompt?.trim()) return null;
  const model = process.env.AGENT_MODEL || 'gpt-4o-mini';
  const userContent = firstField
    ? `Mensagem inicial do usuário: "${messageText}"\n\nApós sua saudação, faça naturalmente a seguinte pergunta: "${firstField.question}"`
    : `Mensagem inicial do usuário: "${messageText}"\n\nResponda com uma saudação inicial adequada.`;
  const completion = await getOpenAI().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: agent.prompt.trim() },
      { role: 'user',   content: userContent },
    ],
    temperature: 0.4,
    max_tokens: 300,
  });
  return (completion.choices[0].message.content || '').trim() || null;
}

async function deriveFieldWithLLM(agent, fieldDef, collectedFields) {
  if (!agent.prompt?.trim()) return null;
  const model = process.env.AGENT_MODEL || 'gpt-4o-mini';
  const systemContent = [
    agent.prompt.trim(),
    '',
    'Sua única tarefa agora é derivar o valor do campo abaixo com base nos campos já coletados.',
    'Retorne SOMENTE o valor final, sem explicações, frases ou unidades extras.',
    'Se não conseguir determinar o valor, retorne: __INVALIDO__',
  ].join('\n');
  const userContent = [
    `Campo a derivar: "${fieldDef.name}"`,
    `Instrução: "${fieldDef.question}"`,
    `Campos já coletados: ${JSON.stringify(collectedFields)}`,
    '',
    `Qual o valor de "${fieldDef.name}"?`,
  ].join('\n');
  const completion = await getOpenAI().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user',   content: userContent },
    ],
    temperature: 0,
    max_tokens: 20,
  });
  const val = (completion.choices[0].message.content || '').trim();
  if (!val || val.toLowerCase().includes('__invalido__')) return null;
  return val;
}

async function normalizeFieldWithLLM(agent, fieldDef, rawValue) {
  if (!agent.prompt?.trim()) return rawValue;
  const model = process.env.AGENT_MODEL || 'gpt-4o-mini';
  const systemContent = [
    agent.prompt.trim(),
    '',
    'Sua única tarefa agora é extrair e formatar o valor do campo abaixo da resposta do usuário.',
    'Retorne SOMENTE o valor formatado, sem explicações, pontuação extra ou frases adicionais.',
    'Se o sistema definir um formato específico para este campo, siga-o rigorosamente.',
    'Se não for possível identificar ou formatar o valor corretamente, retorne apenas: __INVALIDO__',
  ].join('\n');
  const userContent = [
    `Campo: "${fieldDef.name}"`,
    `Pergunta feita ao usuário: "${fieldDef.question}"`,
    `Resposta do usuário: "${rawValue}"`,
    '',
    `Extraia e formate o valor do campo "${fieldDef.name}" conforme as instruções do sistema:`,
  ].join('\n');
  const completion = await getOpenAI().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user',   content: userContent },
    ],
    temperature: 0,
    max_tokens: 60,
  });
  const normalized = (completion.choices[0].message.content || '').trim();
  if (!normalized || normalized.toLowerCase().includes('__invalido__')) return null;
  return normalized;
}

async function sendAndClose(client, from, convKey, reason) {
  const conv    = activeConversations.get(convKey);
  const agents  = loadAgents(conv?.email);
  const agent   = agents.find(a => a.id === conv?.agentId);
  const endMsg  = agent?.endMessage?.trim() ||
    'Fico por aqui! Se precisar de mais alguma coisa é só chamar. 😊';
  activeConversations.delete(convKey);
  console.log(`🔚 Conversa encerrada (${reason}): ${convKey}`);
  await client.sendText(from, endMsg).catch(() => {});
  const sessionName = convKey.split('::')[0];
  await sendSelfMessage(sessionName, agent, conv).catch(() => {});
}

/* ─────────────────────────────────────────────────────────────
   FUNÇÃO PRINCIPAL
───────────────────────────────────────────────────────────── */
export async function runAgent(sessionName, from, messageText) {
  const email    = SESSIONS.get(sessionName)?.email;
  const convKey  = `${sessionName}::${from}`;
  const agents   = loadAgents(email);
  const existing = activeConversations.get(convKey);

  let agent;
  let isNewConversation = false;

  if (existing) {
    agent = agents.find(a => a.id === existing.agentId && a.active);

    if (!agent) {
      activeConversations.delete(convKey);
      return false;
    }

    if (agent.endKeywords && matchesKeywords(agent.endKeywords, messageText)) {
      const session = SESSIONS.get(sessionName);
      if (session?.client) await sendAndClose(session.client, from, convKey, 'palavra de encerramento');
      return true;
    }

    existing.turns++;
    existing.lastActivity = Date.now();

    const maxTurns = parseInt(agent.maxTurns) || 0;
    if (maxTurns > 0 && existing.turns > maxTurns) {
      const session = SESSIONS.get(sessionName);
      if (session?.client) await sendAndClose(session.client, from, convKey, `máximo de ${maxTurns} turnos`);
      return true;
    }

    console.log(`🔄 [${sessionName}] Turno ${existing.turns} com ${from} | agente: ${agent.name}`);
  } else {
    console.log(`🔍 [${sessionName}] ${agents.length} agente(s) | mensagem: "${messageText.slice(0, 60)}"`);

    agent = agents.find(a => matchesAgent(a, messageText));
    if (!agent) {
      console.log(`⏭️  [${sessionName}] Nenhum agente correspondeu.`);
      return false;
    }

    activeConversations.set(convKey, {
      agentId:         agent.id,
      email,
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

  const requiredFields = Array.isArray(agent.requiredFields) ? agent.requiredFields : [];
  const conv = activeConversations.get(convKey);

  if (requiredFields.length > 0) {
    if (isNewConversation) {
      for (const f of requiredFields) {
        if (['date', 'number'].includes(f.extractType) && !conv.collectedFields[f.name]) {
          const v = extractFieldValue(f.extractType, messageText);
          if (v !== null) conv.collectedFields[f.name] = v;
        }
      }
    } else if (conv.awaitingField) {
      const fDef = requiredFields.find(f => f.name === conv.awaitingField);
      if (fDef) {
        let v = extractFieldValue(fDef.extractType || 'text', messageText);
        const promptMentionsField = agent.prompt?.includes(`{${fDef.name}}`);
        if (v !== null && promptMentionsField && !['date', 'date_us', 'number', 'uppercase'].includes(fDef.extractType)) {
          v = (await normalizeFieldWithLLM(agent, fDef, v).catch(() => v)) ?? null;
        }
        if (v !== null) {
          conv.collectedFields[conv.awaitingField] = v;
          conv.awaitingField = null;
          console.log(`📋 Campo "${fDef.name}" = ${v}`);
        } else {
          await session.client.sendText(from, fDef.question);
          return true;
        }
      }
    }

    // Loop: campos silent são derivados pelo LLM; campos normais pedem ao usuário
    while (true) {
      const missing = requiredFields.find(f => !conv.collectedFields[f.name]);
      if (!missing) break;

      if (missing.silent && agent.prompt?.trim()) {
        const derived = await deriveFieldWithLLM(agent, missing, conv.collectedFields).catch(() => null);
        if (derived) {
          conv.collectedFields[missing.name] = derived;
          console.log(`🤖 Campo "${missing.name}" derivado = ${derived}`);
          continue;
        }
      }

      conv.awaitingField = missing.name;
      if (isNewConversation && agent.prompt?.trim()) {
        const intro = await generateIntroMessage(agent, messageText, missing).catch(() => null);
        await session.client.sendText(from, intro || missing.question);
      } else {
        await session.client.sendText(from, missing.question);
      }
      return true;
    }
    console.log(`✅ Todos os campos coletados:`, JSON.stringify(conv.collectedFields));
  }

  console.log(`🤖 Agente "${agent.name}" processando | "${messageText.slice(0, 60)}"`);

  // Bot agendado simples: sem endpoint nem RAG — encerra após coletar campos
  if (conv?.isScheduled && !agent.endpoint && !agent.ragEnabled) {
    await sendAndClose(session.client, from, convKey, 'bot agendado simples');
    return true;
  }

  try {
    if (agent.ragEnabled) {
      const chunks = await retrieveContext(
        email, sessionName, agent.id, messageText, Number(agent.ragTopK) || 5
      );
      if (!chunks.length) {
        const noDataMsg = (agent.ragNoDataMessage || '').trim()
          || 'Não encontrei essa informação na base de conhecimento.';
        await session.client.sendText(from, noDataMsg);
        return true;
      }
      const contextBlock = chunks
        .map((c, i) => `[Fonte: ${c.source} — trecho ${i + 1}]\n${c.text}`)
        .join('\n\n---\n\n');
      const model = process.env.AGENT_MODEL || 'gpt-4o-mini';
      const completion = await getOpenAI().chat.completions.create({
        model,
        messages: [
          { role: 'system', content: RAG_GUARDRAIL },
          { role: 'user',   content: `CONTEXTO DISPONÍVEL:\n\n${contextBlock}\n\n---\n\nPERGUNTA: ${messageText}` },
        ],
        temperature: 0.1,
        max_tokens:  600,
      });
      const reply = (completion.choices[0].message.content || '').trim();
      if (!reply) throw new Error('Resposta vazia do LLM');
      await session.client.sendText(from, reply);
      console.log(`✅ Agente RAG "${agent.name}" respondeu para ${from}`);
      return true;
    }

    const method = (agent.method || 'GET').toUpperCase();
    let endpointResponse;

    if (method === 'GET') {
      const { data } = await axios.get(agent.endpoint, { timeout: 10_000 });
      endpointResponse = data;
    } else {
      let bodyStr = agent.requestTemplate || '{}';
      const fields = conv?.collectedFields || {};

      bodyStr = bodyStr
        .replace(/\{\{message\}\}/g, messageText.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
        .replace(/\{\{session\}\}/g, sessionName);

      bodyStr = bodyStr.replace(/"{{(\w+)}}"/g, (_, k) => {
        const v = fields[k];
        if (v == null || v === '') return '""';
        return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      });

      bodyStr = bodyStr.replace(/\{\{(\w+)\}\}/g, (_, k) => {
        const v = fields[k];
        if (v == null || v === '') return '0';
        return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      });

      console.log(`📤 POST → ${agent.endpoint}\n${bodyStr}`);
      const { data } = await axios({ method, url: agent.endpoint, data: JSON.parse(bodyStr), timeout: 10_000 });
      console.log(`📥 Resposta endpoint:\n${JSON.stringify(data, null, 2).slice(0, 2000)}`);
      endpointResponse = data;
    }

    let payload = extractByPath(endpointResponse, agent.responsePath);
    const responseLimit = parseInt(agent.responseLimit) || 0;
    if (responseLimit > 0 && Array.isArray(payload)) payload = payload.slice(0, responseLimit);

    const closeAfter = endpointResponse?.closeAfter === true;

    // Se o endpoint sinalizar resetField (ex: conflito de horário), limpa o campo,
    // envia a mensagem de conflito direto ao usuário e aguarda nova resposta.
    // Não passa pelo LLM nessa rodada para evitar que ele encerre a conversa.
    const resetFieldName = typeof endpointResponse?.resetField === 'string'
      ? endpointResponse.resetField : null;
    if (resetFieldName && conv?.collectedFields) {
      delete conv.collectedFields[resetFieldName];
      const fDef = requiredFields.find(f => f.name === resetFieldName);
      conv.awaitingField = resetFieldName;
      const conflictMsg = endpointResponse?.mensagem || fDef?.question || `Por favor, informe um novo valor para ${resetFieldName}.`;
      console.log(`🔄 Campo "${resetFieldName}" resetado por sinal do endpoint`);
      await session.client.sendText(from, conflictMsg);
      return true;
    }

    const endKwList = (agent.endKeywords || '').split(',').map(k => k.trim()).filter(Boolean);
    const quitInstruction = endKwList.length
      ? `Quando o usuário demonstrar satisfação, agradecimento ou usar qualquer uma destas palavras de encerramento: ${endKwList.join(', ')} — finalize sua resposta adicionando exatamente \\quit na última linha (sem aspas, sem explicação). Esse é um sinal interno que não será exibido ao usuário.`
      : `Quando perceber que a conversa chegou ao fim (agradecimento, despedida, satisfação) — finalize sua resposta adicionando exatamente \\quit na última linha (sem aspas, sem explicação). Esse é um sinal interno que não será exibido ao usuário.`;

    const systemContent = closeAfter
      ? [
          agent.prompt.trim(),
          '',
          'RESULTADO: O agendamento foi CONFIRMADO COM SUCESSO e o evento já foi criado na agenda.',
          'INSTRUÇÕES OBRIGATÓRIAS:',
          '- Envie UMA ÚNICA mensagem amigável confirmando o agendamento.',
          '- Inclua no mínimo: nome do cliente, serviço/tipo, data e horário confirmado.',
          '- NÃO mencione "ocupado", "conflito", "horário indisponível" ou qualquer problema.',
          '- NÃO faça nenhuma pergunta adicional.',
          '- NÃO invente informações além das que estão no JSON abaixo.',
        ].join('\n')
      : [
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

    const shouldQuit = /\\quit\s*$/im.test(rawReply);
    const reply      = rawReply.replace(/\n?\\quit\s*$/im, '').trim();

    await session.client.sendText(from, reply);
    console.log(`✅ Agente "${agent.name}" respondeu para ${from}`);

    if (shouldQuit || closeAfter) {
      activeConversations.delete(convKey);
      console.log(`🔚 [${sessionName}] Conversa encerrada via ${closeAfter ? 'closeAfter do endpoint' : '\\quit do LLM'}`);
      await sendSelfMessage(sessionName, agent, conv).catch(() => {});
    }
    return true;
  } catch (err) {
    console.error(`❌ Erro no agente "${agent.name}":`, err.message);
    activeConversations.delete(convKey);
    return false;
  }
}
