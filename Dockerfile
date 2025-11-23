FROM node:20-slim

# Install git, python and build tools (required for better-sqlite3)
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source and built files
COPY dist ./dist
COPY orchestrator.sqlite* ./

# Create worktrees directory
RUN mkdir -p /worktrees

CMD ["node", "dist/orchestrator.js"]
