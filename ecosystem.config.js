/**
 * PM2 Ecosystem Configuration
 *
 * This file configures PM2 to run the X4 app server (telemetry + command bridge,
 * what the co-captain MCP server talks to) and the savegame watcher as background
 * daemons that outlive any terminal or Claude session.
 *
 * Usage:
 *   npm i -g pm2
 *   pm2 start ecosystem.config.js --only x4-app-server   # the one the co-captain needs
 *   pm2 start ecosystem.config.js                         # both
 *   pm2 logs x4-app-server
 *   pm2 restart x4-app-server
 *   pm2 stop x4-app-server
 *   pm2 delete x4-app-server
 *   pm2 save                                              # remember the process list
 *
 * To resurrect after a reboot on Windows: `npm i -g pm2-windows-startup && pm2-startup install`,
 * then `pm2 save`.
 */

module.exports = {
  apps: [
    {
      name: 'x4-app-server',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      error_file: './logs/server-error.log',
      out_file: './logs/server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Never let PM2's own env leak into the process — server.js reads .env itself.
      env: {},
      kill_timeout: 5000
    },
    {
      name: 'x4-watcher',
      script: './watcher.js',

      // Process management
      instances: 1,
      exec_mode: 'fork',

      // Auto-restart configuration
      autorestart: true,
      watch: false, // Don't watch for file changes (we're not developing)
      max_memory_restart: '200M', // Restart if memory exceeds 200MB

      // Restart behavior
      min_uptime: '10s', // Minimum uptime before considering it a stable start
      max_restarts: 10, // Maximum number of unstable restarts
      restart_delay: 4000, // Delay between restarts (ms)

      // Error handling
      error_file: './logs/watcher-error.log',
      out_file: './logs/watcher-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Environment
      env: {
        NODE_ENV: 'production'
      },

      // Windows-specific
      kill_timeout: 5000, // Time to wait for graceful shutdown
      wait_ready: true, // Wait for process to emit 'ready' event
      listen_timeout: 10000 // Timeout for ready event
    }
  ]
};
