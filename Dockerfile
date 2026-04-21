FROM node:20.20.2-alpine3.22 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20.20.2-alpine3.22
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# The node:alpine image ships a pre-created unprivileged `node` user/group.
# Running as root gives a compromise inside the process write access to the
# whole container filesystem; dropping to `node` keeps the blast radius
# confined to /app and /tmp. No network/USB privileges are needed — TRON
# signing runs on the host, this image is for EVM-only read surfaces.
USER node
ENTRYPOINT ["node", "dist/index.js"]
