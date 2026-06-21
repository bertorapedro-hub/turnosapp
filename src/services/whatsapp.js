const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { db } = require('../models/database');
const pino = require('pino');
const QRCode = require('qrcode');

// Map de sesiones: negocioId (number|'superadmin') -> { socket, estado, telefono, negocioId }
const sesiones = new Map();
// Map de último QR por negocioId
const ultimosQR = new Map();
// Map de último error por negocioId
const ultimosErrores = new Map();
// Map de callbacks de QR por negocioId
const qrCallbacksMap = new Map();

// ─── helpers ───────────────────────────────────────────────────────────────

function getEstado(negocioId) {
  const sesion = sesiones.get(negocioId);
  const qr = ultimosQR.get(negocioId) || null;
  const error = ultimosErrores.get(negocioId) || null;
  if (!sesion) return { connected: false, phone: null, hasQR: !!qr, error };
  return { connected: sesion.estado === 'open', phone: sesion.telefono || null, hasQR: !!qr, negocioId: sesion.negocioId, error };
}

function getQR(negocioId) {
  return ultimosQR.get(negocioId) || null;
}

function onNuevoQR(negocioId, cb) {
  if (!qrCallbacksMap.has(negocioId)) qrCallbacksMap.set(negocioId, []);
  qrCallbacksMap.get(negocioId).push(cb);
  return () => {
    const cbs = qrCallbacksMap.get(negocioId) || [];
    qrCallbacksMap.set(negocioId, cbs.filter(x => x !== cb));
  };
}

// ─── auth state en SQL ──────────────────────────────────────────────────────

function makeSqlAuthState(negocioId) {
  const isSuperadmin = negocioId === 'superadmin';
  let row;
  if (isSuperadmin) {
    row = db.prepare('SELECT * FROM superadmin_whatsapp WHERE id=1').get();
  } else {
    row = db.prepare('SELECT * FROM whatsapp_sessions WHERE negocio_id=?').get(negocioId);
  }

  let currentCreds = null, currentKeys = {};
  if (row?.creds) { try { currentCreds = JSON.parse(row.creds, BufferJSON.reviver); } catch {} }
  if (row?.keys)  { try { currentKeys  = JSON.parse(row.keys, BufferJSON.reviver);  } catch {} }
  if (!currentCreds || !currentCreds.noiseKey) currentCreds = initAuthCreds();

  function save() {
    const credsStr = JSON.stringify(currentCreds, BufferJSON.replacer);
    const keysStr  = JSON.stringify(currentKeys,  BufferJSON.replacer);
    if (isSuperadmin) {
      db.prepare('INSERT OR REPLACE INTO superadmin_whatsapp (id, creds, keys, updated_at) VALUES (1,?,?,CURRENT_TIMESTAMP)')
        .run(credsStr, keysStr);
    } else {
      db.prepare('INSERT OR REPLACE INTO whatsapp_sessions (negocio_id, creds, keys, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)')
        .run(negocioId, credsStr, keysStr);
    }
  }

  return {
    state: {
      creds: currentCreds,
      keys: {
        get: (type, ids) => {
          const d = {};
          for (const id of ids) { const v = currentKeys[`${type}:${id}`]; if (v !== undefined) d[id] = v; }
          return d;
        },
        set: (data) => {
          for (const cat in data) for (const id in data[cat]) currentKeys[`${cat}:${id}`] = data[cat][id];
          save();
        }
      }
    },
    saveCreds: save
  };
}

// ─── conectar ───────────────────────────────────────────────────────────────

async function conectarWhatsApp(negocioId) {
  const sesionActual = sesiones.get(negocioId);
  if (sesionActual && sesionActual.estado === 'open') return { already: true };

  ultimosQR.set(negocioId, null);
  ultimosErrores.set(negocioId, null);

  try {
    const { state, saveCreds } = makeSqlAuthState(negocioId);
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: state.keys },
      logger: pino({ level: 'silent' }),
      browser: ['TurnosApp', 'Chrome', '1.0'],
    });

    sesiones.set(negocioId, { socket: sock, estado: 'connecting', telefono: null, negocioId });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataURL = await QRCode.toDataURL(qr);
          ultimosQR.set(negocioId, qrDataURL);
          ultimosErrores.set(negocioId, null);
          (qrCallbacksMap.get(negocioId) || []).forEach(cb => cb(qrDataURL));
        } catch (e) { console.error(`[WA ${negocioId}] Error generando QR:`, e.message); }
      }

      if (connection === 'open') {
        const phone = sock.user?.id?.split(':')[0] || '';
        sesiones.set(negocioId, { socket: sock, estado: 'open', telefono: phone, negocioId });
        ultimosQR.set(negocioId, null);
        ultimosErrores.set(negocioId, null);

        if (negocioId === 'superadmin') {
          db.prepare('UPDATE superadmin_whatsapp SET connected=1, phone_number=? WHERE id=1').run(phone);
        } else {
          db.prepare('UPDATE whatsapp_sessions SET connected=1, phone_number=? WHERE negocio_id=?').run(phone, negocioId);
        }
        console.log(`✅ WhatsApp conectado [${negocioId}]: ${phone}`);
      }

      if (connection === 'close') {
        const s = sesiones.get(negocioId);
        if (s) sesiones.set(negocioId, { ...s, estado: 'close' });

        const code = lastDisconnect?.error?.output?.statusCode;
        const motivo = lastDisconnect?.error?.message || 'Conexión cerrada';

        if (negocioId === 'superadmin') {
          db.prepare('UPDATE superadmin_whatsapp SET connected=0 WHERE id=1').run();
        } else {
          db.prepare('UPDATE whatsapp_sessions SET connected=0 WHERE negocio_id=?').run(negocioId);
        }

        if (code !== DisconnectReason.loggedOut) {
          ultimosErrores.set(negocioId, motivo);
          console.log(`🔄 [${negocioId}] Reconectando en 5s... motivo:`, motivo);
          setTimeout(() => conectarWhatsApp(negocioId), 5000);
        } else {
          // Logout limpio: borrar sesión guardada
          sesiones.delete(negocioId);
          ultimosQR.delete(negocioId);
          ultimosErrores.delete(negocioId);
          if (negocioId === 'superadmin') {
            db.prepare('UPDATE superadmin_whatsapp SET creds=NULL, keys=NULL, connected=0 WHERE id=1').run();
          } else {
            db.prepare('UPDATE whatsapp_sessions SET creds=NULL, keys=NULL, connected=0 WHERE negocio_id=?').run(negocioId);
          }
        }
      }
    });

    return { ok: true };
  } catch (e) {
    ultimosErrores.set(negocioId, e.message);
    console.error(`[WA ${negocioId}] Error al conectar:`, e.message);
    throw e;
  }
}

// ─── enviar mensaje ─────────────────────────────────────────────────────────

async function enviarMensaje(negocioId, telefono, mensaje) {
  const sesion = sesiones.get(negocioId);
  if (!sesion || sesion.estado !== 'open') throw new Error(`WhatsApp no conectado [${negocioId}]`);
  const jid = telefono.replace(/\D/g, '') + '@s.whatsapp.net';
  await sesion.socket.sendMessage(jid, { text: mensaje });
}

// ─── desconectar ────────────────────────────────────────────────────────────

function desconectar(negocioId) {
  const sesion = sesiones.get(negocioId);
  if (sesion?.socket) { try { sesion.socket.end(); } catch {} }
  sesiones.delete(negocioId);
  ultimosQR.delete(negocioId);
  ultimosErrores.delete(negocioId);

  if (negocioId === 'superadmin') {
    db.prepare('UPDATE superadmin_whatsapp SET connected=0 WHERE id=1').run();
  } else {
    db.prepare('UPDATE whatsapp_sessions SET connected=0 WHERE negocio_id=?').run(negocioId);
  }
}

// ─── reconectar al arrancar ─────────────────────────────────────────────────

async function reconectarSesionesGuardadas() {
  // Reconectar todos los negocios con sesión guardada
  const sesionesNegocio = db.prepare('SELECT negocio_id FROM whatsapp_sessions WHERE connected=1').all();
  for (const { negocio_id } of sesionesNegocio) {
    console.log(`🔄 Reconectando WhatsApp negocio ${negocio_id}...`);
    conectarWhatsApp(negocio_id).catch(console.error);
  }

  // Reconectar superadmin si tenía sesión
  const sa = db.prepare('SELECT connected FROM superadmin_whatsapp WHERE id=1').get();
  if (sa?.connected) {
    console.log('🔄 Reconectando WhatsApp superadmin...');
    conectarWhatsApp('superadmin').catch(console.error);
  }
}

module.exports = {
  conectarWhatsApp,
  enviarMensaje,
  getEstado,
  getQR,
  desconectar,
  reconectarSesionesGuardadas,
  onNuevoQR,
};
