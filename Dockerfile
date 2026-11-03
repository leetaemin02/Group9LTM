# ─────────────────────────────────────────────────────────────
# ChatMatch – Nhóm 9: Image cho WebSocket server
# Build context là thư mục gốc vì server.js phục vụ ../frontend
# ─────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app/backend

# Cài dependencies trước để tận dụng cache layer
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Mã nguồn backend + frontend tĩnh (giữ đúng cấu trúc /app/backend, /app/frontend)
COPY backend/ ./
COPY frontend/ /app/frontend/

# Không chạy bằng root
USER node

ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

