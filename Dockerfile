FROM node:20-alpine

WORKDIR /app

# Install dependencies (runmq and bullmq from npm)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Create results directory
RUN mkdir -p results

# --expose-gc enables global.gc() for forcing garbage collection between runs.
CMD ["node", "--expose-gc", "dist/runner.js"]
