// PM2 process file for a Hostinger VPS: pm2 start ecosystem.config.cjs
// One instance only: the app uses SQLite and runs its own scheduler (alerts, hand-overs).
module.exports = {
  apps: [{
    name: 'sec-wms',
    script: 'src/server.js',
    node_args: '--no-warnings --env-file-if-exists=.env',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '512M',
    kill_timeout: 6000,
    env: { NODE_ENV: 'production' },
    out_file: 'logs/out.log',
    error_file: 'logs/error.log',
    time: true,
  }],
};
