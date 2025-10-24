import zod from 'zod';

const envSchema = zod.object({
    // Database connections
    OLD_DATABASE_URL: zod.string().optional(),
    LEGACY_DATABASE_URL: zod.string().optional(), // Alternative name for old database
    PRODUCTS_DATABASE_URL: zod.string(),
    REDIS_URL: zod.string(),

    // Migration flags
    TEST_MODE: zod.string().transform((value) => value === 'true').optional(),
    DAILY_MIGRATION: zod.string().transform((value) => value === 'true').optional(),

    // Worker configuration
    WORKER_ID: zod.string().optional(),
    MAX_RETRIES: zod.string().transform((value) => parseInt(value) || 3).optional(),
    RETRY_DELAY: zod.string().transform((value) => parseInt(value) || 60).optional(),
}).refine((data) => {
    // Ensure at least one old database URL is provided
    return data.OLD_DATABASE_URL || data.LEGACY_DATABASE_URL;
}, {
    message: "Either OLD_DATABASE_URL or LEGACY_DATABASE_URL must be provided",
    path: ["OLD_DATABASE_URL"]
});

let env: zod.infer<typeof envSchema>;

try {
    env = envSchema.parse(process.env);
} catch (error) {
    console.error('❌ Invalid environment variables:', error);
    console.log('\n📋 Required environment variables:');
    console.log('  - OLD_DATABASE_URL or LEGACY_DATABASE_URL');
    console.log('  - PRODUCTS_DATABASE_URL');
    console.log('  - REDIS_URL');
    console.log('\n📋 Optional environment variables:');
    console.log('  - TEST_MODE=true (for testing with limited data)');
    console.log('  - WORKER_ID=worker-1 (for distributed processing)');
    console.log('  - MAX_RETRIES=3');
    console.log('  - RETRY_DELAY=60');
    process.exit(1);
}

// Use OLD_DATABASE_URL if available, otherwise use LEGACY_DATABASE_URL
env.OLD_DATABASE_URL = env.OLD_DATABASE_URL || env.LEGACY_DATABASE_URL;

export { env };