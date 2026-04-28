import WebSocket from 'ws';
import { sessionClients } from '../state.js';

let wss;

export function initWss(server) {
  wss = new WebSocket.Server({ server });
  return wss;
}

export function getWss() {
  return wss;
}

export function broadcastQR(sessionName) {
  if (!wss) return;
  const qrPath = `/qrcodes/qrcode_${sessionName}.png?t=${Date.now()}`;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'qr', sessionName, qrPath }));
  });
}

export function broadcastSessionAuthenticated(sessionName) {
  if (!wss) return;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'authenticated', sessionName }));
  });
}

export function setupWebSocket() {
  wss.on('connection', ws => {
    ws.on('message', msg => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'requestQR' && data.sessionName) {
          sessionClients.set(data.sessionName, ws);
          broadcastQR(data.sessionName);
        }
      } catch (err) {
        console.error('WS message error:', err);
      }
    });
    ws.on('close', () => {
      for (const [name, client] of sessionClients.entries()) {
        if (client === ws) { sessionClients.delete(name); break; }
      }
    });
  });
}
