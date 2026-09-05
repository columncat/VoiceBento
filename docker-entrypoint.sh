#!/bin/sh
# 설정이 생길 때까지 기다렸다가, 모델을 챙기고, 시작한다.
#
# 형제 앱들과 같은 모양이다 (PaperBento 의 같은 파일을 보라). 다른 것이 하나
# 있다 — 시작 전에 전사 모델이 볼륨에 있는지 보고, 없으면 받는다.
set -e

CONFIG_DIR="${BENTO_CONFIG_DIR:-/config}"
CONFIG="$CONFIG_DIR/voicebento.env"
DONE="$CONFIG_DIR/setup.json"

# 설정을 환경변수로 직접 받는 배포는 기다리지 않는다.
#
# 이 갈림길이 없으면 멀쩡히 돌던 배포가 다음 이미지에서 영영 기다리기만 한다.
# 실제로 형제 앱에서 그랬다 — 22분 동안 "설정을 기다립니다" 만 찍으며 앱이
# 안 떴다. 기다림은 스택이 관리하는 배포(BENTO_MANAGED=1)에서만 한다.
if [ "${BENTO_MANAGED:-}" = "1" ] || [ -f "$DONE" ]; then
  waited=0
  while [ ! -f "$DONE" ] || [ ! -f "$CONFIG" ]; do
    if [ "$waited" -eq 0 ]; then
      echo "[voicebento] 설정을 기다립니다 — 메일함 쪽(3000 번)의 설치 마법사에서 진행하세요."
    fi
    waited=$((waited + 3))
    if [ $((waited % 60)) -eq 0 ]; then
      echo "[voicebento] 아직 설정이 없습니다 (${waited}초째)."
    fi
    sleep 3
  done

  if [ ! -r "$CONFIG" ]; then
    echo "[voicebento] $CONFIG 를 읽을 수 없습니다 (지금 uid=$(id -u))." >&2
    echo "  호스트 폴더의 주인이 다릅니다. 스택 폴더에서 한 번 돌리세요:" >&2
    echo "    docker compose run --rm --no-deps --user 0 --entrypoint sh voicebento \\" >&2
    echo "      -c 'chown -R 1001:1001 /app/data'" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a
  echo "[voicebento] 설정을 읽었습니다."
else
  echo "[voicebento] 환경변수로 설정된 배포입니다."
fi

# ── 모델 ──
#
# 671MB 라 이미지에 굽지 않는다. 볼륨에 두고 여기서 챙긴다 — 이미 있으면
# 스크립트가 곧바로 끝난다 (파일 검사 몇 번).
#
# **실패해도 앱은 뜬다.** 여기서 멈추면 네트워크가 잠깐 안 될 때 앱 전체가
# 안 뜬다. 모델이 없으면 전사만 실패하고, 그 실패 메시지가 무엇이 없는지
# 그대로 말해 준다 — 화면은 멀쩡히 열린다.
if [ "${AUTO_FETCH_MODEL:-1}" = "1" ]; then
  # 스택이 자리를 물려 줬으면 그쪽이 이긴다 (`scripts/fetch-model.mjs`).
  # 여기서 MODEL_DIR 만 찍으면 실제로 쓰는 자리와 다른 말을 하게 된다.
  echo "[voicebento] 전사 모델을 확인합니다 (${ASR_MODEL_DIR:-${MODEL_DIR:-/app/data/models}})."
  node /app/scripts/fetch-model.mjs || \
    echo "[voicebento] 모델을 준비하지 못했습니다. 전사만 실패하고 앱은 그대로 뜹니다." >&2
fi

echo "[voicebento] 앱을 시작합니다."
exec node server.js
