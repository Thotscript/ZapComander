import path from 'path';
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { SESSIONS } from '../state.js';
import { getAudioDuration } from '../utils/helpers.js';
import { saveSessionLog } from '../db/logs.js';
import { AUDIO_DIR } from '../config/constants.js';

const TRANSCRICOES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'transcricoes');
if (!fs.existsSync(TRANSCRICOES_DIR)) fs.mkdirSync(TRANSCRICOES_DIR, { recursive: true });

function transcreverComWhisperLocal(audioPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'whisper',
      ['--model', WHISPER_MODEL, '--language', 'pt', '--output_format', 'txt', '--output_dir', TRANSCRICOES_DIR, audioPath],
      { timeout: 300_000 },
      (error) => {
        if (error) return reject(error);
        const baseName  = path.basename(audioPath, path.extname(audioPath));
        const outPath   = path.join(TRANSCRICOES_DIR, `${baseName}.txt`);
        try {
          const text = fs.readFileSync(outPath, 'utf8').trim();
          fs.unlinkSync(outPath);
          resolve(text);
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHISPER_MODEL  = process.env.WHISPER_MODEL || 'small';

export async function processAudio(sessionName, message) {
  const session = SESSIONS.get(sessionName);
  if (!session) return;

  const { client, myNumber, email } = session;
  if (!myNumber) { console.warn(`⚠️ myNumber não definido para ${sessionName}`); return; }

  const contact    = await client.getContact(message.from).catch(() => null);
  const senderName = contact?.name || contact?.pushname || message.from;
  console.log(`🔊 Transcrevendo áudio de ${senderName} — sessão ${sessionName}`);

  const sessionSafe  = sessionName.replace(/\W/g, '');
  const inputPath    = path.join(AUDIO_DIR, `${sessionSafe}_${message.id}.ogg`);
  const denoisedPath = path.join(AUDIO_DIR, `${sessionSafe}_${message.id}_clean.ogg`);
  let buffer = await client.decryptFile(message);

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(inputPath);
    stream.write(buffer, err => err ? reject(err) : resolve());
    stream.end();
  });
  buffer = null;

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-i', inputPath, '-af', 'afftdn', '-y', denoisedPath]);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg code ${code}`)));
      proc.on('error', reject);
    });
  } catch {
    console.warn('FFmpeg falhou, usando arquivo original.');
    fs.copyFileSync(inputPath, denoisedPath);
  }

  const duration = await getAudioDuration(denoisedPath);
  console.log(`⏱️  Duração: ${parseFloat(duration.toFixed(2))}s`);

  let transcript = '';
  try {
    console.log('🎙️  Transcrevendo com Whisper local...');
    transcript = await transcreverComWhisperLocal(denoisedPath);
    console.log('✅ Whisper local concluído.');
  } catch (localErr) {
    console.warn('⚠️ Whisper local falhou, usando API OpenAI:', localErr.message);
    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(denoisedPath));
      formData.append('model', 'whisper-1');
      formData.append('language', 'pt');
      const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
        headers: { ...formData.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: 30000
      });
      transcript = resp.data.text?.trim() || '';
    } catch (apiErr) {
      console.error('Falha na transcrição (API OpenAI):', apiErr.message);
    }
  }

  if (!transcript) {
    await client.sendText(message.from, 'Não consegui transcrever o áudio.', { quotedMsg: message.id });
    return;
  }

  await client.sendText(message.from, transcript, { quotedMsg: message.id });
  console.log(`✅ Transcrição enviada para ${senderName}`);

  for (const p of [inputPath, denoisedPath]) {
    try { if (fs.existsSync(p)) await fs.promises.unlink(p); } catch {}
  }

  try {
    await saveSessionLog({ email, sessaoNumero: sessionName, whatsappNumero: message.from });
  } catch (err) {
    console.error('Erro ao gravar log de sessão:', err.message);
  }
}
