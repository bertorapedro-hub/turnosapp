const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'turnosapp_secret_2024';

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

module.exports = { authSuperadmin, authAdmin, JWT_SECRET };
