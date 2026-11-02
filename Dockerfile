FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/ ./
COPY frontend/ /app/frontend/

USER node

EXPOSE 3001

CMD ["node", "server.js"]
