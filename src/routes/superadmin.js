const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../models/database');
const { authSuperadmin, JWT_SECRET } = require('../middleware/auth');

function calcularFechaVencimiento() {
  const hoy = new Date();
  const diasRestantesMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate() - hoy.getDate();
  const base = diasRestantesMes <= 7
    ? new Date(hoy.getFullYear(), hoy.getMonth() + 2, 0)
    : new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
  return base.toISOString().split('T')[0];
}

// ============ Login ============
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const sa = db.prepare('SELECT * FROM superadmin WHERE username=?').get(username);
  if (!sa || !bcrypt.compareSync(password, sa.password_hash))
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = jwt.sign({ id: sa.id, role: 'superadmin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: sa.username });
});

router.put('/password', authSuperadmin, (req, res) => {
  const { password_actual, password_nuevo } = req.body;
  const sa = db.prepare('SELECT * FROM superadmin WHERE id=1').get();
  if (!bcrypt.compareSync(password_actual, sa.password_hash))
    return res.status(400).json({ error: 'Contraseña actual incorrecta' });
  db.prepare('UPDATE superadmin SET password_hash=? WHERE id=1').run(bcrypt.hashSync(password_nuevo, 10));
  res.json({ ok: true });
});

// ============ Negocios ============
router.get('/negocios', authSuperadmin, (req, res) => {
  const negocios = db.prepare('SELECT * FROM negocios ORDER BY created_at DESC').all();
  res.json(negocios);
});

router.post('/negocios', authSuperadmin, async (req, res) => {
  const { nombre, slug, email, telefono, tipo } = req.body;
  if (!nombre || !slug) return res.status(400).json({ error: 'Nombre y slug requeridos' });
  const token = require('crypto').randomBytes(32).toString('hex');
  const fechaVencimiento = calcularFechaVencimiento();
  try {
    const result = db.prepare(`
      INSERT INTO negocios (nombre, slug, email, telefono, tipo, plan, precio_mensual, fecha_vencimiento, estado, token)
      VALUES (?, ?, ?, ?, ?, 'mensual', 0, ?, 'activo', ?)
    `).run(nombre, slug.toLowerCase().replace(/\s+/g, '-'), email || null, telefono || null,
      tipo || 'individual', fechaVencimiento, token);
    const negocioId = result.lastInsertRowid;
    db.prepare("INSERT INTO mensajes_config (negocio_id, tipo, mensaje, hora_envio, dias_antes) VALUES (?, 'recordatorio', '👋 Hola *{{nombre}}*! Te recordamos tu turno mañana *{{fecha}}* a las *{{hora}}*. ¡Te esperamos! 🗓️', '09:00', 1)").run(negocioId);
    db.prepare("INSERT INTO mensajes_config (negocio_id, tipo, mensaje, hora_envio, dias_antes) VALUES (?, 'confirmacion', '✅ *{{nombre}}*, tu turno quedó confirmado para el *{{fecha}}* a las *{{hora}}*. ¡Hasta pronto!', '09:00', 0)").run(negocioId);
    db.prepare("INSERT INTO mensajes_config (negocio_id, tipo, mensaje, hora_envio, dias_antes) VALUES (?, 'aviso_profesional', '📅 Hola *{{profesional}}*! Tenés un nuevo turno asignado:\n\n👤 Cliente: {{nombre}}\n🗓️ Fecha: {{fecha}}\n🕐 Hora: {{hora}}\n\nPor favor confirmá la disponibilidad.', '09:00', 0)").run(negocioId);
    res.json({ id: negocioId, token, fecha_vencimiento: fechaVencimiento });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'El slug ya existe' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/negocios/:id', authSuperadmin, (req, res) => {
  const { nombre, email, telefono, tipo, estado } = req.body;
  db.prepare('UPDATE negocios SET nombre=COALESCE(?,nombre), email=COALESCE(?,email), telefono=COALESCE(?,telefono), tipo=COALESCE(?,tipo), estado=COALESCE(?,estado) WHERE id=?')
    .run(nombre || null, email || null, telefono || null, tipo || null, estado || null, req.params.id);
  res.json({ ok: true });
});

router.delete('/negocios/:id', authSuperadmin, (req, res) => {
  db.prepare('DELETE FROM negocios WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/negocios/:id/renovar', authSuperadmin, (req, res) => {
  const negocio = db.prepare('SELECT * FROM negocios WHERE id=?').get(req.params.id);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const base = negocio.fecha_vencimiento && new Date(negocio.fecha_vencimiento) > new Date()
    ? new Date(negocio.fecha_vencimiento) : new Date();
  base.setMonth(base.getMonth() + 1);
  const nuevaFecha = base.toISOString().split('T')[0];
  db.prepare("UPDATE negocios SET fecha_vencimiento=?, estado='activo' WHERE id=?").run(nuevaFecha, req.params.id);
  res.json({ fecha_vencimiento: nuevaFecha });
});

// ============ WhatsApp Superadmin ============
const { conectarWhatsApp, getEstado, getQR, desconectar, onNuevoQR } = require('../services/whatsapp');
const SA_ID = 'superadmin';

router.post('/whatsapp/conectar', authSuperadmin, async (req, res) => {
  try {
    await conectarWhatsApp(SA_ID);
    res.json({ ok: true, message: 'Iniciando conexión, esperá el QR...' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp/estado', authSuperadmin, (req, res) => {
  res.json(getEstado(SA_ID));
});

router.get('/whatsapp/qr', authSuperadmin, (req, res) => {
  const qr = getQR(SA_ID);
  if (!qr) return res.status(404).json({ error: 'Sin QR disponible' });
  res.json({ qr });
});

router.get('/whatsapp/qr-stream', (req, res) => {
  let decoded;
  try { decoded = jwt.verify(req.query.token, JWT_SECRET); } catch { return res.status(401).end(); }
  if (decoded.role !== 'superadmin') return res.status(403).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const qrActual = getQR(SA_ID);
  if (qrActual) res.write(`data: ${JSON.stringify({ qr: qrActual })}\n\n`);

  const unsub = onNuevoQR(SA_ID, (qr) => res.write(`data: ${JSON.stringify({ qr })}\n\n`));

  let ultimoErrorEnviado = null;
  const check = setInterval(() => {
    const estado = getEstado(SA_ID);
    if (estado.connected) {
      res.write(`data: ${JSON.stringify({ connected: true, phone: estado.phone })}\n\n`);
      clearInterval(check);
    } else if (estado.error && estado.error !== ultimoErrorEnviado) {
      ultimoErrorEnviado = estado.error;
      res.write(`data: ${JSON.stringify({ error: estado.error })}\n\n`);
    }
  }, 2000);

  req.on('close', () => { unsub(); clearInterval(check); });
});

router.post('/whatsapp/desconectar', authSuperadmin, (req, res) => {
  desconectar(SA_ID);
  res.json({ ok: true });
});

// ============ Backup / Restore ============
const fs = require('fs');
const multer = require('multer');
const { DB_PATH, forceSave } = require('../models/database');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

router.get('/backup', (req, res) => {
  try {
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'superadmin') return res.status(403).end();
  } catch { return res.status(401).end(); }
  forceSave(); // aseguramos que lo último en memoria esté escrito en el archivo antes de descargar
  const fecha = new Date().toISOString().split('T')[0];
  res.download(DB_PATH, `turnosapp-backup-${fecha}.db`);
});

router.post('/restore', authSuperadmin, upload.single('backup'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  // Validar que sea un archivo SQLite real (header estándar de 16 bytes)
  const header = file.buffer.slice(0, 16).toString('utf8');
  if (header !== 'SQLite format 3\u0000') {
    return res.status(400).json({ error: 'El archivo no es un backup válido de TurnosApp (no es una base SQLite)' });
  }
  try {
    fs.writeFileSync(DB_PATH, file.buffer);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo escribir el archivo: ' + e.message });
  }
  res.json({ ok: true, message: 'Backup restaurado. El servidor se va a reiniciar en unos segundos para aplicar los cambios.' });
  // Reiniciamos el proceso para que cargue la base nueva desde cero.
  // PM2 lo levanta automáticamente (autorestart por defecto).
  setTimeout(() => process.exit(0), 1000);
});

module.exports = router;
