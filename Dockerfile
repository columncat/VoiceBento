# syntax=docker/dockerfile:1

# ── ffmpeg (정적 바이너리 하나만 꺼내 온다) ──
#
# `apt install ffmpeg` 은 Debian 에서 **+648MB** 다 (X11·GTK 까지 딸려 온다).
# 이쪽은 파일 하나 135MB. 우리가 쓰는 것은 "영상에서 소리를 뽑아 16kHz 모노
# WAV 로" 뿐이라 그 하나면 충분하다.
#
# `ffprobe` 는 **일부러 안 가져온다** — 또 135MB 이고, 길이는 정규화한 WAV 의
# 표본 수에서 정확히 나온다 (`scripts/transcribe.mjs`).
FROM mwader/static-ffmpeg:7.1 AS ff

# ── 베이스 (glibc) — better-sqlite3 와 sherpa-onnx 의 prebuild 를 쓸 수 있다 ──
#
# musl(alpine) 이 아니라 glibc 여야 한다. sherpa-onnx 의 네이티브 바이너리가
# glibc 빌드다.
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ── 앱 의존성 (better-sqlite3 컴파일 대비 빌드툴 포함) ──
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# ── 전사 워커 의존성 (네이티브 ASR) ──
#
# 앱과 **갈라서** 설치한다. 이 패키지는 Next 서버가 부르는 것이 아니라
# `scripts/transcribe.mjs` 라는 별도 프로그램이 자식 프로세스에서 쓴다
# (그래야 하는 이유는 그 파일 첫머리에). 플랫폼별 네이티브 바이너리가 수백
# MB 라, 빌더 단계의 node_modules 에 섞이지 않게 두는 편이 낫다.
FROM base AS asr
WORKDIR /asr
COPY scripts/package.json scripts/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ── 빌드 (Next standalone) ──
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 하위 경로 배포용. 비우면 뿌리에서 돈다.
# Next 가 이 값을 산출물 곳곳에 미리 심으므로 런타임에는 바꿀 수 없다.
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
RUN npm run build

# ── 런타임 ──
FROM base AS runner
ENV NODE_ENV=production
# 컨테이너 **안**에서는 3000 이다. 형제 셋도 전부 3000 이고,
# compose 가 `"${VOICEBENTO_PORT:-3003}:3000"` 으로 호스트 3003 에 잇는다.
# 여기를 3003 으로 두면 안에서는 3003 이 듣는데 compose 는 3000 을 내보내
# **아무것도 응답하지 않는다** — /voice 가 통째로 죽는다. 3003 은 호스트 쪽
# 숫자다.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_PATH=/app/data/voicebento.db
ENV WORK_DIR=/app/data/work
ENV MODEL_DIR=/app/data/models
ENV MIGRATIONS_DIR=/app/drizzle
ENV FFMPEG_PATH=/usr/local/bin/ffmpeg

# bzip2 — 모델 묶음이 `.tar.bz2` 이고 Node 에는 그걸 푸는 것이 없다.
# 수백 KB 라 값이 없는 것이나 마찬가지다 (`scripts/fetch-model.mjs`).
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ff /ffmpeg /usr/local/bin/ffmpeg

RUN useradd -m -u 1001 nodejs

# standalone 출력물 + 정적 자산 + 마이그레이션 SQL
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/drizzle ./drizzle

# 워커와 그 의존성.
#
# Next 의 standalone 추적은 이것을 못 챙긴다 — 앱 코드가 `require` 하지 않고
# `child_process.spawn` 으로 띄우기 때문이다. 그래서 손으로 넣는다.
# 자리가 `/app/scripts/node_modules` 인 것도 뜻이 있다: Node 는
# `/app/scripts/transcribe.mjs` 에서 바로 옆의 `node_modules` 를 먼저 본다.
COPY --from=builder /app/scripts ./scripts
COPY --from=asr /asr/node_modules ./scripts/node_modules

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 영속 디렉터리 (compose 볼륨으로 마운트).
#   data/         — SQLite
#   data/work/    — 전사하는 동안의 임시 파일. 끝나면 지운다.
#   data/models/  — 전사 모델 671MB + 화자 분리 모델 34.3MB(분할 6.0MB +
#                   임베딩 28.3MB). **이미지에 굽지 않는다** (그러면 1.7GB 다).
#                   분리 모델만 굽는 것도 안 한다 — 34MB 는 싸지만 그러면
#                   모델이 사는 자리가 둘이 되고, 어느 쪽이 진짜인지 묻는
#                   자리가 코드에 하나 더 생긴다.
# /config 는 스택의 컨테이너들이 함께 보는 자리 — 여기서는 읽기만 한다.
RUN mkdir -p /app/data/work /app/data/models /config && chown -R nodejs:nodejs /app /config
USER nodejs

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
