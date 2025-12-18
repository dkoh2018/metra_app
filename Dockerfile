FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to install pnpm globally
USER root

# Set working directory
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy package files and patches (needed for pnpm install)
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches/

# Change ownership to pptruser for the app directory
RUN chown -R pptruser:pptruser /app

# Switch back to non-root user for security
USER pptruser

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY --chown=pptruser:pptruser . .

# Build the app
RUN pnpm run build

# Set environment variables
ENV NODE_ENV=production
# Let Puppeteer auto-detect Chrome path in its cache
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

# Expose the port
EXPOSE 3001

# Start the server
CMD ["pnpm", "run", "start"]
