#!/usr/bin/env bun

/**
 * Standalone Daily Migration Script
 *
 * This script can be run as a cron job to perform daily incremental migrations
 * from the old database to the new database.
 *
 * Features:
 * - Migrates products updated since yesterday
 * - Updates providers, products, histories, and multimedia
 * - Distributed processing with Redis coordination
 * - Comprehensive logging and error handling
 *
 * Usage:
 *   bun src/scripts/daily-migration-standalone.ts
 *
 * Environment Variables Required:
 *   - OLD_DATABASE_URL or LEGACY_DATABASE_URL
 *   - PRODUCTS_DATABASE_URL
 *   - REDIS_URL
 *   - Optional: TEST_MODE=true (for testing with limited data)
 *   - Optional: WORKER_ID (for distributed processing)
 *
 * Cron Job Example:
 *   # Run daily at 5 AM/ 12 AM BOGOTÁ time zone
 *   0 5 * * * cd /path/to/migrate-data-script && bun src/scripts/daily-migration-standalone.ts >> /var/log/daily-migration.log 2>&1
 */

import { env } from '../config';
import { productsDb } from '../db/config/products';
import { oldDb, oldDbPool } from '../db/config/old';
import { redisClient } from '../db/config/redis';
import { runDailyMigration, getDailyMigrationProgress } from './daily-migration';

// Configuration
const SCRIPT_NAME = 'Daily Migration Standalone';
const MAX_EXECUTION_TIME = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const PROGRESS_CHECK_INTERVAL = 30 * 1000; // 30 seconds

/**
 * Logger with timestamp
 */
function log(message: string) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}

/**
 * Error logger
 */
function logError(message: string, error?: any) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`);
    if (error) {
        console.error(`[${timestamp}] Error details:`, error);
    }
}

/**
 * Validate required environment variables
 */
function validateEnvironment(): void {
    const required = [
        'PRODUCTS_DATABASE_URL',
        'REDIS_URL'
    ];

    // Check for old database URL (support both names)
    const hasOldDb = env.OLD_DATABASE_URL || process.env.LEGACY_DATABASE_URL;
    if (!hasOldDb) {
        throw new Error('Missing OLD_DATABASE_URL or LEGACY_DATABASE_URL environment variable');
    }

    for (const variable of required) {
        if (!process.env[variable]) {
            throw new Error(`Missing required environment variable: ${variable}`);
        }
    }

    log('✓ Environment variables validated');
}

/**
 * Test database connections
 */
async function testConnections(): Promise<void> {
    log('Testing database connections...');

    try {
        // Test old database
        await oldDb.execute('SELECT 1');
        log('✓ Old database connection successful');

        // Test products database
        await productsDb.execute('SELECT 1');
        log('✓ Products database connection successful');

        // Test Redis connection
        if (!redisClient.isOpen) {
            throw new Error('Redis connection not established');
        }
        await redisClient.ping();
        log('✓ Redis connection successful');

    } catch (error) {
        throw new Error(`Database connection failed: ${error.message}`, { cause: error });
    }
}

/**
 * Get migration statistics
 */
async function getMigrationStats(): Promise<void> {
    try {
        const progress = await getDailyMigrationProgress();

        if (progress.status === 'not_initialized') {
            log('Migration not yet started');
            return;
        }

        log(`Migration Status: ${progress.status}`);
        log(`Progress: ${progress.progressPercent}% (${progress.completedChunks}/${progress.totalChunks} chunks)`);

        if (progress.customProgress) {
            log(`Migration Date: ${progress.customProgress.migrationDate}`);
            log(`Total Updated Products: ${progress.customProgress.totalUpdatedProducts}`);
        }

    } catch (error) {
        logError('Failed to get migration statistics', error);
    }
}

/**
 * Monitor migration progress with timeout
 */
async function monitorMigration(): Promise<boolean> {
    const startTime = Date.now();
    let lastProgress = 0;

    log('Starting migration monitoring...');

    while (Date.now() - startTime < MAX_EXECUTION_TIME) {
        try {
            const progress = await getDailyMigrationProgress();

            if (progress.status === 'not_initialized') {
                log('Waiting for migration to initialize...');
                await new Promise(resolve => setTimeout(resolve, PROGRESS_CHECK_INTERVAL));
                continue;
            }

            const currentProgress = parseFloat(progress.progressPercent || '0');

            if (currentProgress > lastProgress) {
                log(`Migration progress: ${currentProgress}% (${progress.completedChunks}/${progress.totalChunks} chunks completed)`);
                lastProgress = currentProgress;
            }

            // Check if completed
            if (progress.status === 'completed' || currentProgress >= 100) {
                log('✓ Migration completed successfully!');
                return true;
            }

            // Wait before next check
            await new Promise(resolve => setTimeout(resolve, PROGRESS_CHECK_INTERVAL));

        } catch (error) {
            logError('Error monitoring migration progress', error);
            await new Promise(resolve => setTimeout(resolve, PROGRESS_CHECK_INTERVAL));
        }
    }

    // Timeout reached
    logError(`Migration timeout reached (${MAX_EXECUTION_TIME / 1000 / 60} minutes)`);
    return false;
}

/**
 * Cleanup connections
 */
async function cleanup(): Promise<void> {
    log('Cleaning up connections...');

    try {
        // Close database connections
        if (productsDb.$client) {
            productsDb.$client.end();
            log('✓ Products database connection closed');
        }

        if (oldDbPool) {
            await oldDbPool.end();
            log('✓ Old database connection closed');
        }

        // Close Redis connection
        if (redisClient.isOpen) {
            await redisClient.quit();
            log('✓ Redis connection closed');
        }
    } catch (error) {
        logError('Error during cleanup', error);
    }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
    const startTime = Date.now();

    log(`Starting ${SCRIPT_NAME}...`);
    log(`Worker ID: ${process.env.WORKER_ID || 'default'}`);
    log(`Test Mode: ${process.env.TEST_MODE === 'true' ? 'ENABLED' : 'DISABLED'}`);

    try {
        // Step 1: Validate environment
        validateEnvironment();

        // Step 2: Test connections
        await testConnections();

        // Step 3: Show current date for logging
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const migrationDate = yesterday.toISOString().split('T')[0];
        log(`Migration target date: ${migrationDate} (yesterday)`);

        // Step 4: Start migration
        log('Starting daily migration...');

        // Run migration in background and monitor progress
        const migrationPromise = runDailyMigration();
        const monitoringPromise = monitorMigration();

        // Wait for either migration completion or timeout
        const migrationSuccess = await Promise.race([
            migrationPromise.then(() => true),
            monitoringPromise
        ]);

        if (migrationSuccess) {
            const duration = (Date.now() - startTime) / 1000;
            log(`✓ Daily migration completed successfully in ${duration.toFixed(1)} seconds`);

            // Show final statistics
            await getMigrationStats();

            process.exit(0);
        } else {
            logError('Migration failed or timed out');
            process.exit(1);
        }

    } catch (error) {
        logError('Migration failed with error', error);
        process.exit(1);
    } finally {
        await cleanup();
    }
}

/**
 * Handle process signals for graceful shutdown
 */
process.on('SIGINT', async () => {
    log('Received SIGINT, shutting down gracefully...');
    await cleanup();
    process.exit(130);
});

process.on('SIGTERM', async () => {
    log('Received SIGTERM, shutting down gracefully...');
    await cleanup();
    process.exit(143);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    logError('Unhandled Rejection at:', promise);
    logError('Reason:', reason);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logError('Uncaught Exception:', error);
    process.exit(1);
});

// Start the migration
main().catch((error) => {
    logError('Fatal error in main function', error);
    process.exit(1);
});