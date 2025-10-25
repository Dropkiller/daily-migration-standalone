module.exports = {
  apps: [
    {
      name: "universal-migration",
      script: "/Users/fede/.bun/bin/bun",
      args: "run ./src/main.ts",
      cwd: "/Users/fede/Desktop/Scalboost/dropkiller/daily-migration-standalone",
      instances: 8,
      autorestart: false,
      watch: false,
      max_memory_restart: "2G",
      env: {
        NODE_ENV: "production",
      },
      env_development: {
        NODE_ENV: "development",
      },
      // Logs específicos para migración universal
      out_file: "./logs/universal-migration-out.log",
      error_file: "./logs/universal-migration-error.log",
      log_file: "./logs/universal-migration-combined.log",
      time: true,

      // Configuración específica para migración
      max_restarts: 3,
      min_uptime: "30s",
      kill_timeout: 10000, // 10 segundos para permitir cleanup
      
      // Variables de entorno específicas para migración
      env_vars: {
        MIGRATION_CHUNK_SIZE: "500",
        MIGRATION_BATCH_SIZE: "50",
        MIGRATION_PARALLEL_BATCHES: "5"
      }
    }
  ]
};
