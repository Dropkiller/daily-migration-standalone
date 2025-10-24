#!/usr/bin/env bun

/**
 * Main Migration Runner
 *
 * Ejecuta la migración simple con procesamiento distribuido usando BaseMigration
 * Optimizado para ejecución manual o cronjob
 */

import { SimpleMigration } from './scripts/simple-migration-distributed';

async function main() {
    console.log('🚀 Starting Dropkiller Migration...');
    console.log(`Mode: ${process.env.TEST_MODE === 'true' ? 'TEST' : 'PRODUCTION'}`);
    console.log(`Worker ID: ${process.env.WORKER_ID || 'auto-generated'}`);

    const migration = new SimpleMigration();

    try {
        await migration.execute();
        console.log('✅ Migration completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    process.exit(130);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    process.exit(143);
});

// Start migration
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});