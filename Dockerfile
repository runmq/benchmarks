FROM node:20-alpine

WORKDIR /workspace

# Copy queue package and install its runtime deps so Node can resolve imports
# from /workspace/queue/dist/index.js correctly.
# To update queue: run `npm run build` in the queue package before docker compose.
COPY queue/package.json ./queue/
RUN cd queue && npm install --omit=dev
COPY queue/dist ./queue/dist

# Install benchmark dependencies (runmq resolves from local ../queue)
COPY benchmark-repo/package.json ./benchmark-repo/
WORKDIR /workspace/benchmark-repo
RUN npm install

# Copy source and build
COPY benchmark-repo/tsconfig.json .
COPY benchmark-repo/src ./src
RUN npx tsc

# Create results directory
RUN mkdir -p results

# --expose-gc enables global.gc() for forcing garbage collection between runs.
CMD ["node", "--expose-gc", "dist/runner.js"]
