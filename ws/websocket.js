import WebSocket from 'ws';
import { sessionClients } from '../state.js';

let wss;
const latestQRPaths = new Map();

export function initWss(server) {
  wss = new WebSocket.Server({ server });
  return wss;
}

export function getWss() {
  return wss;
}

export function broadcastQR(sessionName, qrWebPath) {
  if (!wss || !qrWebPath) return;
  latestQRPaths.set(sessionName, qrWebPath);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'qr', sessionName, qrPath: qrWebPath }));
  });
}

export function broadcastSessionAuthenticated(sessionName) {
  if (!wss) return;
  latestQRPaths.delete(sessionName);
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
          const stored = latestQRPaths.get(data.sessionName);
          if (stored && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'qr', sessionName: data.sessionName, qrPath: stored }));
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
