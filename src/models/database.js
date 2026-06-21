const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'turnosapp.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let _db = null;

function saveDb() {
  if (_db) fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

setInterval(saveDb, 30000);
process.on('exit', saveDb);
process.on('SIGINT', () => { saveDb(); process.exit(); });

const db = {
  prepare: (sql) => ({
    run: (...params) => {
      _db.run(sql, params);
      const r = _db.exec('SELECT last_insert_rowid() as id');
      const lastInsertRowid = r[0]?.values[0][0] || 0;
      saveDb();
      return { lastInsertRowid, changes: 1 };
    },
    get: (...params) => {
      const stmt = _db.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
      stmt.free(); return undefined;
    },
    all: (...params) => {
      const results = [];
      const stmt = _db.prepare(sql);
      stmt.bind(params);
      while (stmt.step()) results.push(stmt.getAsObject());
      stmt.free(); return results;
    }
  }),
  exec: (sql) => { _db.run(sql); saveDb(); },
  pragma: () => {}
};

async function initDb() {
  const SQL = await initSqlJs();
  _db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  _db.run(`
    CREATE TABLE IF NOT EXISTS superadmin (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS superadmin_config (
      clave TEXT PRIMARY KEY, valor TEXT
    );
    CREATE TABLE IF NOT EXISTS negocios (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL, email TEXT, telefono TEXT,
      tipo TEXT DEFAULT 'individual',
      plan TEXT DEFAULT 'mensual',
      precio_mensual REAL DEFAULT 0,
      fecha_vencimiento DATE, estado TEXT DEFAULT 'activo',
      mp_pago_estado TEXT DEFAULT 'pendiente',
      mp_preference_id TEXT,
      token TEXT UNIQUE NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS profesionales (
      id INTEGER PRIMARY KEY AUTOINCREMENT, negocio_id INTEGER NOT NULL,
      nombre TEXT NOT NULL, especialidad TEXT, descripcion TEXT,
      foto_url TEXT, activo INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      negocio_id INTEGER PRIMARY KEY, creds TEXT, keys TEXT,
      connected INTEGER DEFAULT 0, phone_number TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS superadmin_whatsapp (
      id INTEGER PRIMARY KEY DEFAULT 1, creds TEXT, keys TEXT,
      connected INTEGER DEFAULT 0, phone_number TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS servicios (
      id INTEGER PRIMARY KEY AUTOINCREMENT, negocio_id INTEGER NOT NULL,
      profesional_id INTEGER,
      nombre TEXT NOT NULL, duracion_minutos INTEGER DEFAULT 30,
      precio REAL DEFAULT 0, activo INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS horarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT, negocio_id INTEGER NOT NULL,
      profesional_id INTEGER,
      dia_semana INTEGER NOT NULL, hora_inicio TEXT NOT NULL,
      hora_fin TEXT NOT NULL, activo INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, negocio_id INTEGER NOT NULL,
      dni TEXT NOT NULL, nombre TEXT NOT NULL, apellido TEXT NOT NULL,
      telefono TEXT NOT NULL, email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(negocio_id, dni)
    );
    CREATE TABLE IF NOT EXISTS turnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, negocio_id INTEGER NOT NULL,
      profesional_id INTEGER, servicio_id INTEGER,
      cliente_id INTEGER, cliente_nombre TEXT NOT NULL,
      cliente_telefono TEXT NOT NULL, cliente_email TEXT,
      cliente_dni TEXT,
      fecha DATE NOT NULL, hora TEXT NOT NULL,
      estado TEXT DEFAULT 'pendiente', notas TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mensajes_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT, negocio_id INTEGER,
      tipo TEXT NOT NULL, activo INTEGER DEFAULT 1, mensaje TEXT NOT NULL,
      hora_envio TEXT DEFAULT '09:00', dias_antes INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS superadmin_mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL,
      activo INTEGER DEFAULT 1, mensaje TEXT NOT NULL,
      hora_envio TEXT DEFAULT '10:00', dias_antes_vencimiento INTEGER DEFAULT 3
    );
    CREATE TABLE IF NOT EXISTS mensajes_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, negocio_id INTEGER,
      turno_id INTEGER, tipo TEXT, destinatario TEXT, mensaje TEXT,
      estado TEXT DEFAULT 'enviado', sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS servicio_profesionales (
      servicio_id INTEGER NOT NULL, profesional_id INTEGER NOT NULL,
      PRIMARY KEY (servicio_id, profesional_id)
    );
  `);

  // Migraciones con try/catch para tablas existentes
  const migraciones = [
    "ALTER TABLE negocios ADD COLUMN tipo TEXT DEFAULT 'individual'",
    "ALTER TABLE negocios ADD COLUMN plan TEXT DEFAULT 'mensual'",
    "ALTER TABLE negocios ADD COLUMN precio_mensual REAL DEFAULT 0",
    "ALTER TABLE negocios ADD COLUMN mp_pago_estado TEXT DEFAULT 'pendiente'",
    "ALTER TABLE negocios ADD COLUMN mp_preference_id TEXT",
    "ALTER TABLE turnos ADD COLUMN profesional_id INTEGER",
    "ALTER TABLE turnos ADD COLUMN cliente_id INTEGER",
    "ALTER TABLE turnos ADD COLUMN cliente_dni TEXT",
    "ALTER TABLE servicios ADD COLUMN profesional_id INTEGER",
    "ALTER TABLE horarios ADD COLUMN profesional_id INTEGER",
    "ALTER TABLE mensajes_log ADD COLUMN config_id INTEGER",
    "ALTER TABLE profesionales ADD COLUMN telefono TEXT",
    "ALTER TABLE mensajes_config ADD COLUMN unidad TEXT DEFAULT 'dias'",
  ];
  for (const m of migraciones) {
    try { _db.run(m); } catch(e) {}
  }

  // Superadmin inicial
  const existing = db.prepare('SELECT id FROM superadmin WHERE id=1').get();
  if (!existing) {
    const hash = bcrypt.hashSync(process.env.SUPERADMIN_PASS || 'admin1234', 10);
    db.prepare('INSERT INTO superadmin (id, username, password_hash) VALUES (1, ?, ?)')
      .run(process.env.SUPERADMIN_USER || 'superadmin', hash);
    console.log('✅ Superadmin creado');
  }

  // Mensajes superadmin iniciales
  const msgExist = db.prepare('SELECT id FROM superadmin_mensajes LIMIT 1').get();
  if (!msgExist) {
    const msgs = [
      ['vencimiento_proximo', '⚠️ Hola *{{negocio}}*! Tu suscripción vence el *{{fecha_vencimiento}}*. Monto: ${{monto}}. Pagá aquí: {{link_pago}} ¡Gracias!', 3],
      ['vencido', '🔴 Hola *{{negocio}}*! Tu suscripción venció el *{{fecha_vencimiento}}*. Para renovar pagá aquí: {{link_pago}}', 0],
      ['nuevo_negocio', '🎉 ¡Bienvenido a TurnosApp, *{{negocio}}*!\n\n📱 Tu panel de administración: {{link_admin}}\n🔑 Tu token de acceso: `{{token}}`\n📅 Tu página de reservas: {{link_reservas}}\n\n¡Cualquier consulta estamos a disposición!', 0],
      ['link_pago', '💳 Hola *{{negocio}}*! Para renovar tu suscripción (${{monto}}) hacé click aquí:\n{{link_pago}}\n\nVencimiento: {{fecha_vencimiento}}', 0],
    ];
    for (const [tipo, mensaje, dias] of msgs) {
      db.prepare('INSERT INTO superadmin_mensajes (tipo, mensaje, dias_antes_vencimiento) VALUES (?,?,?)').run(tipo, mensaje, dias);
    }
  }

  // Config superadmin inicial
  const configExist = db.prepare("SELECT clave FROM superadmin_config WHERE clave='precio_individual'").get();
  if (!configExist) {
    db.prepare("INSERT OR IGNORE INTO superadmin_config (clave, valor) VALUES ('precio_individual', '5000')").run();
    db.prepare("INSERT OR IGNORE INTO superadmin_config (clave, valor) VALUES ('precio_multi', '8000')").run();
    db.prepare("INSERT OR IGNORE INTO superadmin_config (clave, valor) VALUES ('mp_access_token', '')").run();
  }

  saveDb();
  console.log('✅ Base de datos iniciada');
}

module.exports = { db, initDb };
