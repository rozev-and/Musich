# syntax=docker/dockerfile:1.7
#
# MUSICH: один образ с API-сервером и собранной веб-мордой.
# Контракт: docs/API.md. Мультиархитектурная сборка (amd64 + arm64 для pi5):
#   docker buildx build --platform linux/amd64,linux/arm64 -t musich:latest .
#
# Веб-морда и TypeScript-сервер собираются на платформе сборщика ($BUILDPLATFORM):
# их результат (статика и JS) от архитектуры не зависит, а без QEMU это в разы быстрее.
# Prod-зависимости сервера ставятся уже на целевой платформе — на случай, если
# у какой-то из них окажутся платформенные optional-пакеты.

ARG NODE_VERSION=22

# --- 1. веб-морда ------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- 2. сервер: компиляция TypeScript ---------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS server-build
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build

# --- 3. сервер: только prod-зависимости, под целевую архитектуру -------------
FROM node:${NODE_VERSION}-alpine AS server-deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# --- 4. итоговый образ -------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

# tini — нормальная обработка SIGTERM и зомби; tzdata — чтобы TZ из окружения работал
# ffmpeg — пережимать музыку в MP3 для мобильного интернета (качество потока, server/src/transcode.ts)
RUN apk add --no-cache tini tzdata ffmpeg

ENV NODE_ENV=production \
    PORT=2290 \
    MUSIC_DIR=/music \
    DATA_DIR=/data \
    STATIC_DIR=/app/public \
    SCAN_ON_START=true

WORKDIR /app
COPY --from=server-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=server-build --chown=node:node /src/server/package.json ./package.json
COPY --from=server-build --chown=node:node /src/server/dist ./dist
COPY --from=web-build --chown=node:node /src/web/dist ./public
# шаблон расширения MUSICH ← VK: сервер отдаёт его архивом (путь — ../../extension/vk от dist)
COPY --chown=node:node extension/vk /extension/vk

# каталоги под тома должны принадлежать node, иначе свежий именованный том будет root-овым
RUN mkdir -p /music /data && chown node:node /music /data

# встроенный пользователь node из официального образа (uid/gid 1000)
USER node

VOLUME ["/music", "/data"]
EXPOSE 2290

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2290)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.title="MUSICH" \
      org.opencontainers.image.description="Самописный Immich для музыки: API, хранилище треков и веб-морда"
