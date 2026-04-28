import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { DDI_TO_TIMEZONE, QR_CODES_DIR } from '../config/constants.js';
import { processingQueues } from '../state.js';

export function extractPhoneNumberInfo(sender) {
  const raw   = sender.split('@')[0];
  const clean = raw.replace(/[^\d]/g, '');
  let ddi = null, timezone = null;
  for (const len of [3, 2, 1]) {
    const code = clean.slice(0, len);
    if (DDI_TO_TIMEZONE[code]) { ddi = code; timezone = DDI_TO_TIMEZONE[code]; break; }
  }
  const semDDI = clean.slice(ddi?.length || 0);
  let numeroFormatado = `+${ddi} ${semDDI}`;
  if (ddi === '1')  numeroFormatado = `+${ddi} (${semDDI.slice(0,3)}) ${semDDI.slice(3,6)}-${semDDI.slice(6)}`;
  if (ddi === '55') numeroFormatado = `+${ddi} (${semDDI.slice(0,2)}) ${semDDI.slice(2,7)}-${semDDI.slice(7)}`;
  return { numeroLimpo: clean, ddi, timezone, numeroFormatado };
}

export function normalizeToWhatsAppNumber(formatted) {
  return `${formatted.replace(/\D/g, '')}@c.us`;
}

export function enqueueProcessing(sessionName, fn) {
  const queue    = processingQueues.get(sessionName) || Promise.resolve();
  const newQueue = queue.then(() => fn()).catch(err => {
    console.error(`Erro na fila de ${sessionName}:`, err);
  });
  processingQueues.set(sessionName, newQueue);
}

export function saveQRCode(base64Qr, sessionName) {
  const matches = base64Qr.match(/^data:image\/png;base64,(.+)$/);
  if (!matches) throw new Error('QR Code inválido');
  const qrFilePath = path.join(QR_CODES_DIR, `qrcode_${sessionName}.png`);
  return new Promise((resolve, reject) => {
    fs.writeFile(qrFilePath, Buffer.from(matches[1], 'base64'), err =>
      err ? reject(err) : resolve(qrFilePath)
    );
  });
}

export async function getAudioDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, meta) =>
      err ? reject(err) : resolve(meta.format.duration)
    );
  });
}
