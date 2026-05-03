import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import OpenAI from 'openai';
import { SESSIONS } from '../state.js';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
export const AGENTS_FILE = path.join(__dirname, '..', 'data', 'agents.json');

const openai = new OpenAI({
  apiKey:  'ollama',
  baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
});

export function loadAgents() {
  try { return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); }
  catch { return []; }
}

export function writeAgents(agents) {
  const dir = path.dirname(AGENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf8');
}

function matchesAgent(agent, text) {
  if (!agent.active) return false;
  const lower = text.toLowerCase();
  const kws = (agent.keywords || '')
    .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  return kws.includes('*') || kws.some(kw => kw && lower.includes(kw));
}

function extractByPath(obj, dotPath) {
  if (!dotPath || !dotPath.trim()) return obj;
  return dotPath.trim().split('.').reduce((acc, k) => acc?.[k], obj) ?? obj;
}

export async function runAgent(sessionName, from, messageText) {
  const agents = loadAgents();
  const agent  = agents.find(a => matchesAgent(a, messageText));
  if (!agent) return false;

  const session = SESSIONS.get(sessionName);
  if (!session?.client) return false;

  console.log(`🤖 Agente "${agent.name}" acionado | sessão ${sessionName} | "${messageText.slice(0, 60)}"`);

  try {
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
      const parsed = JSON.parse(bodyStr);
      const { data } = await axios({ method, url: agent.endpoint, data: parsed, timeout: 10_000 });
      endpointResponse = data;
    }

    const payload = extractByPath(endpointResponse, agent.responsePath);

    const systemContent = [
      agent.prompt.trim(),
      '',
      '— Dados recebidos do sistema —',
      JSON.stringify(payload, null, 2),
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model:       process.env.OLLAMA_MODEL || 'qwen2.5:1.5b',
      messages:    [
        { role: 'system', content: systemContent },
        { role: 'user',   content: messageText   },
      ],
      max_tokens:  900,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content.trim();
    await session.client.sendText(from, reply);
    console.log(`✅ Agente "${agent.name}" respondeu para ${from}`);
    return true;
  } catch (err) {
    console.error(`❌ Erro no agente "${agent.name}":`, err.message);
    return false;
  }
}
