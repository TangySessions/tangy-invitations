# Tangy Sessions — Invitation Sender (SQLite by default; DB_BACKEND=postgres
# for the PostgreSQL store). One runtime dependency: pg (exact version in
# package-lock.json). Pin the base image to a digest for reproducible builds.
FROM node:24-alpine
WORKDIR /app
# Self-hosted with a persistent /data volume: SQLite, chosen explicitly.
ENV NODE_ENV=production DB_BACKEND=sqlite DATA_DIR=/data PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
