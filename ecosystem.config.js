module.exports = {
  apps: [
    {
      name: 'signaltrader',
      script: 'npx',
      args: 'tsx scripts/worker.ts --auto',
      cwd: 'C:\\Users\\yecos\\Downloads\\trade\\signalTrade',
      interpreter: 'none',
      env: {
        AUTO_START: 'true',
        NODE_ENV: 'production',
      },
      // Restart policy
      max_restarts: 50,
      restart_delay: 10000,    // 10s between restarts
      autorestart: true,
      watch: false,
      // Logging
      error_file: 'C:\\Users\\yecos\\Downloads\\trade\\signalTrade\\logs\\error.log',
      out_file: 'C:\\Users\\yecos\\Downloads\\trade\\signalTrade\\logs\\out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // Memory
      max_memory_restart: '500M',
    },
  ],
};
