// ZOOM SMS — PM2 process model (Phase-2 ALMADA_ROLE split)
// api   : web + worker exports (user-facing; must never wait on timers)
// sync  : timers only (provider sync + automatic backups)
// Rules: cluster mode KABHI nahi (SQLite single-writer). Dono processes same
// DB file, WAL mode. Small VPS (<8GB / light traffic)? sirf `qtech-sms-all` chalao
// (ALMADA_ROLE unset) — single process, sab kuch andar.
module.exports = {
  apps: [
    {
      name: 'qtech-sms-api',
      script: 'backend/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { ALMADA_ROLE: 'api' },
      max_memory_restart: '1500M',
      time: true,
    },
    {
      name: 'qtech-sms-sync',
      script: 'backend/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { ALMADA_ROLE: 'sync' },
      max_memory_restart: '800M',
      time: true,
    },
  ],
};
