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

# Install dev dependencies needed for the build step
RUN npm install --include=dev --no-save --package-lock=false

# Copy the project sources for the build step
COPY . .

# Build TypeScript to dist/
RUN npm run build

# Drop build-only packages to keep the final image lean
RUN npm prune --production

# Create worktrees directory
RUN mkdir -p /worktrees

CMD ["node", "dist/orchestrator.js"]
