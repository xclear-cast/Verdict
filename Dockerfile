FROM node:22-bookworm-slim

WORKDIR /app

# better-sqlite3 may need native build fallback on some environments.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY orchestrator/package.json orchestrator/package.json
COPY vscode-extension/package.json vscode-extension/package.json

RUN npm ci --workspaces --include-workspace-root

COPY . .

RUN npm run build -w shared \
  && npm run build -w orchestrator

ENV NODE_ENV=production
ENV AGENT_HUB_PORT=3939
ENV AGENT_HUB_SCHEMA_PATH=/app/data/schema.sql
ENV AGENT_HUB_DB_PATH=/app/runtime-data/agent_hub.db
ENV AGENT_HUB_SETTINGS_PATH=/app/runtime-data/runtime_settings.json

RUN mkdir -p /app/runtime-data

EXPOSE 3939

HEALTHCHECK --interval=30s --timeout=5s --retries=5 --start-period=20s \
  CMD node -e "const http=require('http');http.get('http://127.0.0.1:3939/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1));"

CMD ["node", "orchestrator/dist/src/index.js"]
