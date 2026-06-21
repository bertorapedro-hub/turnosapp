const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../models/database');
const { enviarMensaje } = require('../services/whatsapp');
const { reemplazarVariables } = require('../services/scheduler');

// Webhook de Mercado Pago
router.post('/mercadopago', async (req, res) => {
  try {
    const mpToken = db.prepare("SELECT valor FROM superadmin_config WHERE clave='mp_access_token'").get()?.valor;
    if (!mpToken) return res.sendStatus(200);

    // Verificar firma x-signature
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    if (xSignature && xRequestId) {
      const parts = {};
      xSignature.split(',').forEach(p => {
        const [k, v] = p.trim().split('=');
        parts[k] = v;
      });
      const ts = parts['ts'];
      const v1 = parts['v1'];
      const manifest = `id:${req.body?.data?.id};request-id:${xRequestId};ts:${ts};`;
      const secret = mpToken;
      const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
      if (hmac !== v1) {
        console.log('MP webhook firma inválida');
        return res.sendStatus(400);
      }
    }

    const topic = req.body?.type || req.query.topic;
    const paymentId = req.body?.data?.id || req.query.id;

    if (topic !== 'payment' || !paymentId) return res.sendStatus(200);

    // Verificar pago con la API de MP
    const mpRes = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${mpToken}` }
    });
    const payment = mpRes.data;

    if (payment.status !== 'approved') return res.sendStatus(200);

    // Buscar negocio por mp_preference_id
    const prefId = payment.order?.id || payment.preference_id;
    if (!prefId) return res.sendStatus(200);

    const negocio = db.prepare('SELECT * FROM negocios WHERE mp_preference_id=?').get(String(prefId));
    if (!negocio) return res.sendStatus(200);

    // Renovar un mes desde hoy o desde vencimiento actual si es futuro
    const base = negocio.fecha_vencimiento && new Date(negocio.fecha_vencimiento) > new Date()
      ? new Date(negocio.fecha_vencimiento)
      : new Date();
    base.setMonth(base.getMonth() + 1);
    const nuevaFecha = base.toISOString().split('T')[0];

    db.prepare("UPDATE negocios SET fecha_vencimiento=?, estado='activo', mp_pago_estado='pagado', mp_preference_id=NULL WHERE id=?")
      .run(nuevaFecha, negocio.id);

    console.log(`✅ Pago aprobado: negocio ${negocio.nombre}, nueva fecha ${nuevaFecha}`);

    // Log
    db.prepare("INSERT INTO mensajes_log (negocio_id, tipo, destinatario, mensaje, estado) VALUES (?,?,?,?,?)")
      .run(negocio.id, 'pago_recibido', negocio.telefono || '', `Pago aprobado. Nueva fecha: ${nuevaFecha}`, 'ok');

    res.sendStatus(200);
  } catch (e) {
    console.error('Error webhook MP:', e.message);
    res.sendStatus(200); // Siempre 200 para MP
  }
});

module.exports = router;
