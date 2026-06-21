const express = require('express');
const router = express.Router();
const { db } = require('../models/database');
const { enviarMensaje } = require('../services/whatsapp');
const { reemplazarVariables } = require('../services/scheduler');

// Info del negocio por slug
router.get('/negocio/:slug', (req, res) => {
  const n = db.prepare("SELECT id,nombre,slug,tipo FROM negocios WHERE slug=? AND estado='activo'").get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });
  res.json(n);
});

// Buscar cliente por DNI
router.get('/cliente/:slug/:dni', (req, res) => {
  const n = db.prepare("SELECT id FROM negocios WHERE slug=?").get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });
  const c = db.prepare('SELECT * FROM clientes WHERE negocio_id=? AND dni=?').get(n.id, req.params.dni);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(c);
});

// Profesionales activos del negocio
router.get('/profesionales/:slug', (req, res) => {
  const n = db.prepare("SELECT id FROM negocios WHERE slug=?").get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });
  const profs = db.prepare('SELECT * FROM profesionales WHERE negocio_id=? AND activo=1 ORDER BY nombre').all(n.id);
  res.json(profs);
});

// Servicios (opcionalmente filtrados por profesional)
router.get('/servicios/:slug', (req, res) => {
  const n = db.prepare("SELECT id FROM negocios WHERE slug=?").get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { profesional_id } = req.query;
  let sql = 'SELECT * FROM servicios WHERE negocio_id=? AND activo=1';
  const params = [n.id];
  if (profesional_id) {
    sql += ' AND (NOT EXISTS (SELECT 1 FROM servicio_profesionales sp WHERE sp.servicio_id=servicios.id) OR EXISTS (SELECT 1 FROM servicio_profesionales sp WHERE sp.servicio_id=servicios.id AND sp.profesional_id=?))';
    params.push(profesional_id);
  }
  sql += ' ORDER BY nombre';
  res.json(db.prepare(sql).all(...params));
});

// Horarios disponibles (para un día específico)
router.get('/horarios/:slug', (req, res) => {
  const n = db.prepare("SELECT id FROM negocios WHERE slug=?").get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });
  const { fecha, profesional_id } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });

  const diaSemana = new Date(fecha + 'T00:00:00').getDay(); // 0=dom, 1=lun...

  let sqlHor = 'SELECT * FROM horarios WHERE negocio_id=? AND dia_semana=? AND activo=1';
  const paramsHor = [n.id, diaSemana];
  if (profesional_id) { sqlHor += ' AND profesional_id=?'; paramsHor.push(profesional_id); }
  const horarios = db.prepare(sqlHor).all(...paramsHor);

  // Turnos ya ocupados
  let sqlTurnos = "SELECT hora FROM turnos WHERE negocio_id=? AND fecha=? AND estado!='cancelado'";
  const paramsTurnos = [n.id, fecha];
  if (profesional_id) { sqlTurnos += ' AND profesional_id=?'; paramsTurnos.push(profesional_id); }
  const ocupados = db.prepare(sqlTurnos).all(...paramsTurnos).map(t => t.hora);

  // Generar slots
  const slots = [];
  for (const h of horarios) {
    let [hh, mm] = h.hora_inicio.split(':').map(Number);
    const [hfin, mfin] = h.hora_fin.split(':').map(Number);
    while (hh * 60 + mm < hfin * 60 + mfin) {
      const slot = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
      if (!ocupados.includes(slot)) slots.push(slot);
      mm += 30; if (mm >= 60) { hh++; mm -= 60; }
    }
  }
  res.json(slots.sort());
});

// Crear turno (reserva pública)
router.post('/turno/:slug', async (req, res) => {
  const n = db.prepare("SELECT * FROM negocios WHERE slug=? AND estado='activo'").get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'Negocio no encontrado' });

  const { profesional_id, servicio_id, cliente_nombre, cliente_apellido, cliente_telefono, cliente_email, cliente_dni, fecha, hora, notas } = req.body;
  if (!cliente_nombre || !cliente_telefono || !fecha || !hora)
    return res.status(400).json({ error: 'Faltan datos obligatorios' });

  // Verificar disponibilidad
  let sqlOcupado = "SELECT id FROM turnos WHERE negocio_id=? AND fecha=? AND hora=? AND estado!='cancelado'";
  const paramsOcupado = [n.id, fecha, hora];
  if (profesional_id) { sqlOcupado += ' AND profesional_id=?'; paramsOcupado.push(profesional_id); }
  const ocupado = db.prepare(sqlOcupado).get(...paramsOcupado);
  if (ocupado) return res.status(409).json({ error: 'Ese horario ya está ocupado' });

  // Guardar/actualizar cliente
  let clienteId = null;
  if (cliente_dni) {
    const cli = db.prepare('SELECT id FROM clientes WHERE negocio_id=? AND dni=?').get(n.id, cliente_dni);
    if (cli) {
      clienteId = cli.id;
      db.prepare('UPDATE clientes SET nombre=?,apellido=?,telefono=?,email=? WHERE id=?')
        .run(cliente_nombre, cliente_apellido || '-', cliente_telefono, cliente_email || null, cli.id);
    } else {
      const r = db.prepare('INSERT OR IGNORE INTO clientes (negocio_id,dni,nombre,apellido,telefono,email) VALUES (?,?,?,?,?,?)')
        .run(n.id, cliente_dni, cliente_nombre, cliente_apellido || '-', cliente_telefono, cliente_email || null);
      clienteId = r.lastInsertRowid || null;
    }
  }

  const nombreCompleto = [cliente_nombre, cliente_apellido].filter(Boolean).join(' ');
  const result = db.prepare(`INSERT INTO turnos (negocio_id,profesional_id,servicio_id,cliente_id,cliente_nombre,cliente_telefono,cliente_email,cliente_dni,fecha,hora,notas,estado)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pendiente')`)
    .run(n.id, profesional_id || null, servicio_id || null, clienteId, nombreCompleto, cliente_telefono, cliente_email || null, cliente_dni || null, fecha, hora, notas || null);

  // Enviar confirmación WA al cliente
  if (cliente_telefono) {
    const msgConf = db.prepare("SELECT * FROM mensajes_config WHERE negocio_id=? AND tipo='confirmacion' AND activo=1").get(n.id);
    if (msgConf) {
      const servicio = servicio_id ? db.prepare('SELECT nombre FROM servicios WHERE id=?').get(servicio_id) : null;
      const prof = profesional_id ? db.prepare('SELECT nombre FROM profesionales WHERE id=?').get(profesional_id) : null;
      const msg = reemplazarVariables(msgConf.mensaje, {
        nombre: nombreCompleto, fecha, hora,
        servicio: servicio?.nombre || '', profesional: prof?.nombre || '', negocio: n.nombre
      });
      await enviarMensaje(n.id, cliente_telefono, msg).catch(() => {});
      db.prepare("INSERT INTO mensajes_log (negocio_id, turno_id, tipo, destinatario, mensaje, estado) VALUES (?,?,?,?,?,?)")
        .run(n.id, result.lastInsertRowid, 'confirmacion', cliente_telefono, msg, 'enviado');
    }
  }

  res.json({ id: result.lastInsertRowid, message: 'Turno reservado exitosamente' });
});

module.exports = router;
