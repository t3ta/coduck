module.exports = {
  apps: [{
    name: 'coduck-worker',
    script: 'dist/worker.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      ORCHESTRATOR_URL: 'http://localhost:3000',
      WORKER_POLL_INTERVAL_MS: '5000',
      WORKTREE_BASE_DIR: './worktrees',
    },
    error_file: './logs/worker-error.log',
    out_file: './logs/worker-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
