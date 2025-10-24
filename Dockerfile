# Use Bun official image
FROM oven/bun:1.2.13-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src ./src

# Create non-root user for security
RUN addgroup --system --gid 1001 migration && \
    adduser --system --uid 1001 migration

# Set proper permissions
RUN chown -R migration:migration /app
USER migration

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun --version || exit 1

# Set default command
CMD ["bun", "src/main.ts"]

# Labels
LABEL maintainer="Scalboost Team"
LABEL description="Dropkiller Daily Migration - Standalone Version"
LABEL version="1.0.0"