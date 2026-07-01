const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const JWT_SECRET = process.env.JWT_SECRET || 'turnosapp_secret_2024';

// Limita intentos de login (fuerza bruta) a 15 intentos cada 15 minutos por IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Esperá unos minutos y volvé a intentar.' },
});

function authSuperadmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Sin token' });
  try {
    const payload = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    if (payload.role !== 'superadmin') return res.status(403).json({ error: 'No autorizado' });
    req.adminId = payload.id;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

function authAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Sin token' });
  try {
    const payload = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    req.negocioId = payload.negocio_id;
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}

module.exports = { authSuperadmin, authAdmin, JWT_SECRET, loginLimiter };
