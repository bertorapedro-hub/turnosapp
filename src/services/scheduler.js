const cron = require('node-cron');
const axios = require('axios');
const { db } = require('../models/database');
const { enviarMensaje } = require('./whatsapp');

function reemplazarVariables(msg, vars) {
  return msg.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || '');
}

async function procesarRecordatorios() {
  const configs = db.prepare("SELECT * FROM mensajes_config WHERE tipo='recordatorio' AND activo=1 AND (unidad IS NULL OR unidad='dias')").all();
  for (const cfg of configs) {
    const diasAntes = cfg.dias_antes || 1;
    const fechaTarget = new Date();
    fechaTarget.setDate(fechaTarget.getDate() + diasAntes);
    const fecha = fechaTarget.toISOString().split('T')[0];

    const turnos = db.prepare(`
      SELECT t.*, n.nombre as negocio_nombre, s.nombre as servicio_nombre, p.nombre as profesional_nombre
      FROM turnos t
      JOIN negocios n ON n.id = t.negocio_id
      LEFT JOIN servicios s ON s.id = t.servicio_id
      LEFT JOIN profesionales p ON p.id = t.profesional_id
      WHERE t.negocio_id=? AND t.fecha=? AND t.estado='pendiente' AND t.cliente_telefono!=''
    `).all(cfg.negocio_id, fecha);

    for (const turno of turnos) {
      const yaEnviado = db.prepare("SELECT id FROM mensajes_log WHERE turno_id=? AND tipo='recordatorio' AND config_id=?").get(turno.id, cfg.id);
      if (yaEnviado) continue;

      const msg = reemplazarVariables(cfg.mensaje, {
        nombre: turno.cliente_nombre, fecha: turno.fecha, hora: turno.hora,
        servicio: turno.servicio_nombre || '', profesional: turno.profesional_nombre || '',
        negocio: turno.negocio_nombre
      });

      try {
        await enviarMensaje(cfg.negocio_id, turno.cliente_telefono, msg);
        db.prepare("INSERT INTO mensajes_log (negocio_id, turno_id, tipo, destinatario, mensaje, estado, config_id) VALUES (?,?,?,?,?,?,?)")
          .run(cfg.negocio_id, turno.id, 'recordatorio', turno.cliente_telefono, msg, 'enviado', cfg.id);
      } catch (e) {
        db.prepare("INSERT INTO mensajes_log (negocio_id, turno_id, tipo, destinatario, mensaje, estado, config_id) VALUES (?,?,?,?,?,?,?)")
          .run(cfg.negocio_id, turno.id, 'recordatorio', turno.cliente_telefono, msg, 'error: ' + e.message, cfg.id);
      }
    }
  }
}

// Recordatorios configurados en "horas antes" — se evalúan cada 15 minutos
// buscando turnos cuyo horario caiga dentro de la ventana [ahora+horasAntes, ahora+horasAntes+15min)
async function procesarRecordatoriosHoras() {
  const configs = db.prepare("SELECT * FROM mensajes_config WHERE tipo='recordatorio' AND activo=1 AND unidad='horas'").all();
  if (!configs.length) return;
  const ahora = new Date();

  for (const cfg of configs) {
    const horasAntes = cfg.dias_antes || 1;
    const ventanaInicio = new Date(ahora.getTime() + horasAntes * 3600000);
    const ventanaFin = new Date(ventanaInicio.getTime() + 15 * 60000);
    const fechaBusqueda = ventanaInicio.toISOString().split('T')[0];

    const turnos = db.prepare(`
      SELECT t.*, n.nombre as negocio_nombre, s.nombre as servicio_nombre, p.nombre as profesional_nombre
      FROM turnos t
      JOIN negocios n ON n.id = t.negocio_id
      LEFT JOIN servicios s ON s.id = t.servicio_id
      LEFT JOIN profesionales p ON p.id = t.profesional_id
      WHERE t.negocio_id=? AND t.fecha=? AND t.estado='pendiente' AND t.cliente_telefono!=''
    `).all(cfg.negocio_id, fechaBusqueda);

    for (const turno of turnos) {
      const [hh, mm] = turno.hora.split(':').map(Number);
      const turnoDate = new Date(turno.fecha + 'T00:00:00');
      turnoDate.setHours(hh, mm, 0, 0);
      if (turnoDate < ventanaInicio || turnoDate >= ventanaFin) continue;

      const yaEnviado = db.prepare("SELECT id FROM mensajes_log WHERE turno_id=? AND tipo='recordatorio' AND config_id=?").get(turno.id, cfg.id);
      if (yaEnviado) continue;

      const msg = reemplazarVariables(cfg.mensaje, {
        nombre: turno.cliente_nombre, fecha: turno.fecha, hora: turno.hora,
        servicio: turno.servicio_nombre || '', profesional: turno.profesional_nombre || '',
        negocio: turno.negocio_nombre
      });

      try {
        await enviarMensaje(cfg.negocio_id, turno.cliente_telefono, msg);
        db.prepare("INSERT INTO mensajes_log (negocio_id, turno_id, tipo, destinatario, mensaje, estado, config_id) VALUES (?,?,?,?,?,?,?)")
          .run(cfg.negocio_id, turno.id, 'recordatorio', turno.cliente_telefono, msg, 'enviado', cfg.id);
      } catch (e) {
        db.prepare("INSERT INTO mensajes_log (negocio_id, turno_id, tipo, destinatario, mensaje, estado, config_id) VALUES (?,?,?,?,?,?,?)")
          .run(cfg.negocio_id, turno.id, 'recordatorio', turno.cliente_telefono, msg, 'error: ' + e.message, cfg.id);
      }
    }
  }
}

async function procesarAlertasPago() {
  const negocios = db.prepare("SELECT * FROM negocios WHERE estado='activo'").all();
  const msgProximo = db.prepare("SELECT * FROM superadmin_mensajes WHERE tipo='vencimiento_proximo' AND activo=1").get();
  const msgVencido = db.prepare("SELECT * FROM superadmin_mensajes WHERE tipo='vencido' AND activo=1").get();
  const mpToken = db.prepare("SELECT valor FROM superadmin_config WHERE clave='mp_access_token'").get()?.valor;
  const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  for (const n of negocios) {
    if (!n.telefono || !n.fecha_vencimiento) continue;

    const hoy = new Date();
    const vto = new Date(n.fecha_vencimiento);
    const diasRestantes = Math.floor((vto - hoy) / 86400000);
    const monto = n.precio_mensual || 0;

    // Generar link MP si es posible
    let linkPago = '';
    if (mpToken && monto > 0 && !n.mp_preference_id) {
      try {
        const mpRes = await axios.post('https://api.mercadopago.com/checkout/preferences', {
          items: [{ title: `TurnosApp - Suscripción (${n.nombre})`, quantity: 1, unit_price: monto, currency_id: 'ARS' }],
          notification_url: `${BASE_URL}/api/webhooks/mercadopago`,
          external_reference: String(n.id)
        }, { headers: { Authorization: `Bearer ${mpToken}` } });
        linkPago = mpRes.data.init_point;
        db.prepare('UPDATE negocios SET mp_preference_id=?, mp_pago_estado=? WHERE id=?').run(mpRes.data.id, 'pendiente', n.id);
      } catch {}
    }

    const vars = {
      negocio: n.nombre, monto: String(monto),
      fecha_vencimiento: n.fecha_vencimiento,
      link_pago: linkPago, telefono: n.telefono || '', email: n.email || ''
    };

    // Próximo a vencer: alertar según días configurados
    if (msgProximo && diasRestantes >= 0 && diasRestantes <= (msgProximo.dias_antes_vencimiento || 3)) {
      const yaEnviado = db.prepare("SELECT id FROM mensajes_log WHERE negocio_id=? AND tipo='vencimiento_proximo' AND DATE(sent_at)=DATE('now')").get(n.id);
      if (!yaEnviado) {
        const msg = reemplazarVariables(msgProximo.mensaje, vars);
        await enviarMensaje('superadmin', n.telefono, msg).catch(() => {});
        db.prepare("INSERT INTO mensajes_log (negocio_id, tipo, destinatario, mensaje, estado) VALUES (?,?,?,?,?)")
          .run(n.id, 'vencimiento_proximo', n.telefono, msg, 'enviado');
      }
    }

    // Vencido: alertar
    if (msgVencido && diasRestantes < 0) {
      const yaEnviado = db.prepare("SELECT id FROM mensajes_log WHERE negocio_id=? AND tipo='vencido' AND DATE(sent_at)=DATE('now')").get(n.id);
      if (!yaEnviado) {
        const msg = reemplazarVariables(msgVencido.mensaje, vars);
        await enviarMensaje('superadmin', n.telefono, msg).catch(() => {});
        db.prepare("INSERT INTO mensajes_log (negocio_id, tipo, destinatario, mensaje, estado) VALUES (?,?,?,?,?)")
          .run(n.id, 'vencido', n.telefono, msg, 'enviado');
        db.prepare("UPDATE negocios SET mp_pago_estado='vencido' WHERE id=?").run(n.id);
      }
    }
  }
}

function iniciarScheduler() {
  // Recordatorios por días, cada día a las 9:00
  cron.schedule('0 9 * * *', () => {
    console.log('⏰ Enviando recordatorios de turno (días antes)...');
    procesarRecordatorios().catch(console.error);
  });

  // Recordatorios por horas, cada 15 minutos
  cron.schedule('*/15 * * * *', () => {
    procesarRecordatoriosHoras().catch(console.error);
  });

  // Alertas de pago cada día a las 10:00
  cron.schedule('0 10 * * *', () => {
    console.log('⏰ Procesando alertas de pago...');
    procesarAlertasPago().catch(console.error);
  });

  console.log('✅ Scheduler iniciado');
}

module.exports = { iniciarScheduler, procesarAlertasPago, reemplazarVariables, procesarRecordatorios, procesarRecordatoriosHoras };
