require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/superadmin', express.static(path.join(__dirname, 'public/superadmin')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/reservar', express.static(path.join(__dirname, 'public/booking')));

app.use('/api/superadmin', require('./routes/superadmin'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/booking', require('./routes/booking'));
app.use('/api/webhooks', require('./routes/webhooks'));

app.get('/superadmin*', (req, res) => res.sendFile(path.join(__dirname, 'public/superadmin/index.html')));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/reservar/:slug*', (req, res) => res.sendFile(path.join(__dirname, 'public/booking/index.html')));
app.get('/', (req, res) => res.redirect('/superadmin'));

async function start() {
  const { initDb } = require('./models/database');
  await initDb();

  const { iniciarScheduler } = require('./services/scheduler');
  const { reconectarSesionesGuardadas } = require('./services/whatsapp');

  app.listen(PORT, async () => {
    console.log(`🚀 TurnosApp corriendo en http://localhost:${PORT}`);
    iniciarScheduler();
    await reconectarSesionesGuardadas();
  });
}

start().catch(err => { console.error('Error al iniciar:', err); process.exit(1); });
