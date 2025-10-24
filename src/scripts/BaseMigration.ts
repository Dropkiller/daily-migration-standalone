import { redisClient } from "../db/config/redis";

/**
 * Chunk state for distributed processing
 */
export interface ChunkState {
    chunkId: number;
    startOffset: number;
    endOffset: number;
    status: 'pending' | 'processing' | 'completed';
    workerId?: string;
    lastUpdate?: string;
    processedCount?: number;
    [key: string]: any; // Allow additional custom fields
}

/**
 * Configuration for migration behavior
 */
export interface MigrationConfig {
    /** Redis key for migration state */
    stateKey: string;
    /** Redis key for chunks hash */
    chunksKey: string;
    /** Redis key prefix for locks */
    lockPrefix: string;
    /** Number of records to process per batch */
    batchSize: number;
    /** Number of records per chunk */
    chunkSize: number;
    /** Lock TTL in seconds */
    lockTTL: number;
    /** Lock renewal interval in milliseconds */
    lockRenewInterval?: number;
}

/**
 * Result of processing a chunk
 */
export interface ChunkResult {
    processed: number;
    [key: string]: any; // Allow additional metrics
}

/**
 * Abstract base class for distributed data migrations
 *
 * This class handles:
 * - Chunk initialization and management
 * - Distributed locking with Redis
 * - Worker coordination
 * - Progress tracking
 * - Error handling and recovery
 *
 * @example
 * ```typescript
 * class ProductMigration extends BaseMigration<OldProduct> {
 *   protected async getTotalRecords(): Promise<number> {
 *     return await getOldProductsCount();
 *   }
 *
 *   protected async processChunk(chunk: ChunkState): Promise<ChunkResult> {
 *     // Implementation specific logic
 *     return { processed: 100, inserted: 95, skipped: 5 };
 *   }
 * }
 * ```
 */
export abstract class BaseMigration<TRecord = any> {
    protected readonly workerId: string;
    protected readonly config: MigrationConfig;

    constructor(config: MigrationConfig) {
        this.config = config;
        this.workerId = process.env.WORKER_ID || `worker-${Math.random().toString(36).substring(7)}`;
    }

    /**
     * Get the total number of records to migrate
     * Must be implemented by subclass
     */
    protected abstract getTotalRecords(): Promise<number>;

    /**
     * Process a single chunk of data
     * Must be implemented by subclass
     *
     * @param chunk The chunk to process
     * @returns Result with processed count and any additional metrics
     */
    protected abstract processChunk(chunk: ChunkState): Promise<ChunkResult>;

    /**
     * Optional hook called after all chunks are completed
     * Can be overridden by subclass for finalization logic
     */
    protected async onComplete(): Promise<void> {
        // Default: do nothing
    }

    /**
     * Optional hook for custom progress logging
     * Override to add custom metrics to progress
     */
    protected getCustomProgress(): Record<string, any> {
        return {};
    }

    /**
     * Initialize chunks for distributed processing
     */
    public async initializeChunks(totalRecords?: number): Promise<number> {
        this.log(`Getting total records...`);
        const total = totalRecords ?? await this.getTotalRecords();
        this.log(`Total records: ${total}`);
        const totalChunks = Math.ceil(total / this.config.chunkSize);

        this.log(`Initializing ${totalChunks} chunks for ${total} records...`);

        for (let i = 0; i < totalChunks; i++) {
            const chunk: ChunkState = {
                chunkId: i,
                startOffset: i * this.config.chunkSize,
                endOffset: Math.min((i + 1) * this.config.chunkSize, total),
                status: 'pending'
            };

            await redisClient.hSet(
                this.config.chunksKey,
                i.toString(),
                JSON.stringify(chunk)
            );
        }

        this.log(`Initialized ${totalChunks} chunks`);
        return totalChunks;
    }

    /**
     * Acquire a lock for a specific chunk
     */
    protected async acquireLock(chunkId: number): Promise<boolean> {
        const lockKey = `${this.config.lockPrefix}${chunkId}`;
        const acquired = await redisClient.set(lockKey, this.workerId, {
            NX: true,
            EX: this.config.lockTTL
        });
        return acquired === 'OK';
    }

    /**
     * Release lock for a chunk
     */
    protected async releaseLock(chunkId: number): Promise<void> {
        const lockKey = `${this.config.lockPrefix}${chunkId}`;
        await redisClient.del(lockKey);
    }

    /**
     * Renew lock for a chunk
     */
    protected async renewLock(chunkId: number): Promise<void> {
        const lockKey = `${this.config.lockPrefix}${chunkId}`;
        await redisClient.expire(lockKey, this.config.lockTTL);
    }

    /**
     * Get next available chunk to process
     */
    protected async getNextChunk(): Promise<ChunkState | null> {
        const chunks = await redisClient.hGetAll(this.config.chunksKey);

        for (const [chunkId, chunkData] of Object.entries(chunks)) {
            const chunk: ChunkState = JSON.parse(chunkData);

            if (chunk.status === 'pending') {
                if (await this.acquireLock(chunk.chunkId)) {
                    chunk.status = 'processing';
                    chunk.workerId = this.workerId;
                    chunk.lastUpdate = new Date().toISOString();

                    await redisClient.hSet(
                        this.config.chunksKey,
                        chunkId,
                        JSON.stringify(chunk)
                    );

                    return chunk;
                }
            }
        }

        return null;
    }

    /**
     * Mark chunk as completed
     */
    protected async markChunkCompleted(chunkId: number, result: ChunkResult): Promise<void> {
        const chunkData = await redisClient.hGet(this.config.chunksKey, chunkId.toString());
        if (!chunkData) return;

        const chunk: ChunkState = JSON.parse(chunkData);
        chunk.status = 'completed';
        chunk.lastUpdate = new Date().toISOString();

        // Merge result into chunk state
        Object.assign(chunk, result);

        await redisClient.hSet(
            this.config.chunksKey,
            chunkId.toString(),
            JSON.stringify(chunk)
        );

        await this.releaseLock(chunkId);
    }

    /**
     * Mark chunk as pending (for retry)
     */
    protected async markChunkPending(chunkId: number): Promise<void> {
        const chunkData = await redisClient.hGet(this.config.chunksKey, chunkId.toString());
        if (!chunkData) return;

        const chunkState: ChunkState = JSON.parse(chunkData);
        chunkState.status = 'pending';
        chunkState.lastUpdate = new Date().toISOString();

        await redisClient.hSet(
            this.config.chunksKey,
            chunkId.toString(),
            JSON.stringify(chunkState)
        );
    }

    /**
     * Check if all chunks are completed
     */
    protected async areAllChunksCompleted(): Promise<boolean> {
        const chunks = await redisClient.hGetAll(this.config.chunksKey);

        if (!chunks || Object.keys(chunks).length === 0) {
            return false;
        }

        return Object.values(chunks).every(
            chunkData => JSON.parse(chunkData).status === 'completed'
        );
    }

    /**
     * Process chunks with automatic lock renewal
     */
    protected async processChunkWithRenewal(chunk: ChunkState): Promise<ChunkResult> {
        const renewInterval = this.config.lockRenewInterval ?? (this.config.lockTTL * 1000 * 0.4);
        let lastRenew = Date.now();

        // Set up periodic lock renewal
        const renewalTimer = setInterval(async () => {
            if (Date.now() - lastRenew > renewInterval) {
                await this.renewLock(chunk.chunkId);
                lastRenew = Date.now();
            }
        }, renewInterval);

        try {
            return await this.processChunk(chunk);
        } finally {
            clearInterval(renewalTimer);
        }
    }

    /**
     * Main migration execution
     */
    public async execute(): Promise<void> {
        this.log(`Starting migration...`);

        const chunks = await redisClient.hGetAll(this.config.chunksKey);
        if (!chunks || Object.keys(chunks).length === 0) {
            this.log(`No chunks found. Initializing chunks...`);
            await this.initializeChunks();
        }

        let chunksProcessed = 0;
        const workerStats = new Map<string, number>();

        while (true) {
            const chunk = await this.getNextChunk();

            if (!chunk) {
                this.log(`No more chunks available. Checking if migration is complete...`);

                if (await this.areAllChunksCompleted()) {
                    this.log(`All chunks completed!`);
                    await this.onComplete();
                    break;
                } else {
                    this.log(`Waiting for other workers to complete their chunks...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    continue;
                }
            }

            try {
                const result = await this.processChunkWithRenewal(chunk);
                await this.markChunkCompleted(chunk.chunkId, result);

                chunksProcessed++;
                workerStats.set('processed', result.processed + (workerStats.get('processed') || 0));

                this.log(`Completed chunk ${chunk.chunkId}. Total chunks processed by this worker: ${chunksProcessed}`);
            } catch (error) {
                this.logError(`Error processing chunk ${chunk.chunkId}:`, error);
                await this.releaseLock(chunk.chunkId);
                await this.markChunkPending(chunk.chunkId);
            }
        }

        await this.logFinalStatistics(chunksProcessed, workerStats);
    }

    /**
     * Get current progress
     */
    public async getProgress(): Promise<any> {
        const chunks = await redisClient.hGetAll(this.config.chunksKey);

        if (!chunks || Object.keys(chunks).length === 0) {
            return { status: "not_initialized" };
        }

        const chunkStates: ChunkState[] = Object.values(chunks).map(c => JSON.parse(c));
        const total = chunkStates.length;
        const completed = chunkStates.filter(c => c.status === 'completed').length;
        const processing = chunkStates.filter(c => c.status === 'processing').length;
        const pending = chunkStates.filter(c => c.status === 'pending').length;

        const totalProcessed = chunkStates.reduce((sum, c) => sum + (c.processedCount || 0), 0);

        return {
            status: "in_progress",
            totalChunks: total,
            completedChunks: completed,
            processingChunks: processing,
            pendingChunks: pending,
            totalProcessed,
            progressPercent: ((completed / total) * 100).toFixed(2),
            ...this.getCustomProgress()
        };
    }

    /**
     * Reset all progress
     */
    public async reset(): Promise<void> {
        await redisClient.del(this.config.stateKey);
        await redisClient.del(this.config.chunksKey);

        const keys = await redisClient.keys(`${this.config.lockPrefix}*`);
        if (keys.length > 0) {
            for (const key of keys) {
                await redisClient.del(key);
            }
        }

        this.log("Migration progress reset");
    }

    /**
     * Log final statistics
     */
    protected async logFinalStatistics(chunksProcessed: number, workerStats: Map<string, number>): Promise<void> {
        const allChunks = await redisClient.hGetAll(this.config.chunksKey);
        const chunkStates: ChunkState[] = Object.values(allChunks).map(c => JSON.parse(c));

        const globalProcessed = chunkStates.reduce((sum, c) => sum + (c.processedCount || 0), 0);

        this.log(`Migration completed! Processed ${chunksProcessed} chunks.`);
        this.log(`Worker statistics:`);
        for (const [key, value] of workerStats.entries()) {
            this.log(`  - ${key}: ${value}`);
        }
        this.log(`Global statistics:`);
        this.log(`  - Total processed: ${globalProcessed}`);
    }

    /**
     * Utility logging methods
     */
    protected log(message: string): void {
        console.log(`[${this.workerId}] ${message}`);
    }

    protected logError(message: string, error: any): void {
        console.error(`[${this.workerId}] ${message}`, error);
    }
}
