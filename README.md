# TurnosApp

SaaS de gestión de turnos con WhatsApp automático.

## Stack
- Node.js + Express
- sql.js (SQLite en memoria)
- Baileys (WhatsApp pairing code)
- Render.com / Railway

## Setup

```bash
npm install
cp .env.example .env
# Editar .env con tus valores
npm start
```

## URLs
- Superadmin: `/superadmin`
- Admin negocio: `/admin`
- Reservas: `/reservar/:slug`
