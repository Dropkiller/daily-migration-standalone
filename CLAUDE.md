# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Primary Scripts
- `bun run migrate` - Run the complete migration process (all products)
- `bun run start` - Start the main migration script (alias for migrate)
- `bun run test` - Run migration in test mode (limited to 10 products)
- `bun run dev` - Development mode with file watching

### Code Quality
- `bun run typecheck` - Run TypeScript type checking
- `bun run lint` - Run ESLint on TypeScript files

### Alternative Execution
- `bun src/main.ts` - Direct execution of main migration script

## Environment Configuration

Required environment variables:
- `OLD_DATABASE_URL` - Connection to legacy database
- `PRODUCTS_DATABASE_URL` - Connection to new products database
- `REDIS_URL` - Redis server for distributed coordination

Optional variables:
- `TEST_MODE=true` - Limit processing to 10 products for testing
- `WORKER_ID` - Unique identifier for distributed processing
- `MAX_RETRIES=3` - Number of retry attempts for failed operations
- `RETRY_DELAY=60` - Delay between retries in seconds

## Architecture Overview

### High-Level Structure
This is a standalone migration system that transfers all products (400k+) from an old database to a new Dropkiller v3 architecture. The system uses Redis for distributed coordination allowing multiple workers to process chunks concurrently.

### Key Components

**Database Layer (`src/db/`)**
- `config/` - Database connection configurations with retry logic
- `schemas/products/` - New database schema definitions using Drizzle ORM
- `schemas/old/` - Legacy database schema definitions
- Connection pooling with automatic retry and error handling

**Migration Engine (`src/scripts/`)**
- `BaseMigration.ts` - Abstract base class for chunk-based migrations
- `daily-migration.ts` - Core migration implementation extending BaseMigration
- `daily-migration-standalone.ts` - Entry point for standalone execution
- Processes data in optimized chunks (100 products per chunk, 50 per batch)

**Services Layer (`src/services/`)**
- Product transformation and validation logic
- Provider and platform-country relationship management
- History gap detection and filling algorithms
- Multimedia URL processing with CloudFront optimization

**Main Entry Point (`src/main.ts`)**
- Application orchestration with monitoring and timeout handling
- Connection management and graceful shutdown
- Progress tracking with real-time logging

### Data Processing Flow
1. **Initialization** - Validate environment, test connections, initialize Redis
2. **Product Discovery** - Query all products from old database (excludes `rocketfy` platform)
3. **Chunk Processing** - Process in batches with Redis-based coordination
4. **Data Migration** - Products, providers, histories, multimedia with gap detection
5. **Monitoring** - Real-time progress tracking with timeout protection

### Key Technologies
- **Runtime**: Bun (primary), Node.js (fallback)
- **ORM**: Drizzle ORM for type-safe database operations
- **Database**: PostgreSQL (old + new instances)
- **Coordination**: Redis for distributed processing
- **Types**: Full TypeScript with strict type checking

### Distributed Processing
Multiple workers can run concurrently using different `WORKER_ID` values. Redis coordinates chunk allocation to prevent conflicts and ensure complete coverage.

### Error Handling
- Comprehensive retry mechanisms with exponential backoff
- Connection pooling with automatic reconnection
- Graceful shutdown handling for SIGINT/SIGTERM
- Progress persistence for resumable migrations