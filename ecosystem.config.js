/**
 * PM2 Ecosystem Configuration
 *
 * This file configures PM2 to run the X4 Savegame Watcher as a background daemon.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 logs x4-watcher
 *   pm2 restart x4-watcher
 *   pm2 stop x4-watcher
 *   pm2 delete x4-watcher
 */

module.exports = {
  apps: [
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
