/*
 * 환경변수를 한 군데서 읽고 한 번만 검증한다.
 *
 * 여기 없는 값을 `process.env` 에서 직접 꺼내 쓰기 시작하면, 오타 난 이름이
 * 조용히 undefined 로 흘러 들어가 한참 뒤 엉뚱한 곳에서 터진다.
 *
 * 예외가 둘 있다. `AGENT_URL`/`AGENT_TOKEN` 은 프록시 라우트에서 제 자리에서
 * 읽는다 (PaperBento 와 같은 관례 — 그 파일 하나만 보고도 무엇이 필요한지
 * 알 수 있다). 그리고 `scripts/*.mjs` 는 이 모듈을 import 하지 않는다 —
 * 워커는 Next 번들 밖의 독립 프로그램이라 인자와 환경변수로만 이야기한다.
 */
import { z } from "zod";

import { DEFAULT_MODEL_ID, getModel } from "./asr-models";
import { DEFAULT_DIAR_MODEL_ID, getDiarModel } from "./diar-models";

const envSchema = z.object({
  DATABASE_PATH: z.string().default("./data/voicebento.db"),

  /**
   * 전사하는 동안 쓰는 임시 파일 자리.
   *
   * 원본(MemoBento 에서 받아 온 것)과 16kHz 모노 WAV 가 여기 잠깐 산다.
   * 끝나면 지운다. **볼륨에 두어야 한다** — 한 시간짜리 영상이면 원본
   * 수백 MB 에 WAV 가 115MB 다(16000×2바이트×3600초).
   */
  WORK_DIR: z.string().default("./data/work"),

  /**
   * 전사 모델이 풀려 있는 자리.
   *
   * 이미지에 굽지 않는다 — 671MB 라 런타임 이미지가 562MB 에서 1.7GB 로
   * 뛴다. 형제 앱들이 475~494MB 인데 이 앱만 세 배가 될 이유가 없고,
   * 모델은 앱 코드와 달리 배포마다 바뀌지 않는다. `scripts/fetch-model.mjs`
   * 가 볼륨에 받아 두고, 있으면 다시 받지 않는다.
   */
  MODEL_DIR: z.string().default("./data/models"),

  /**
   * 스택이 물려 주는 모델 자리. **있으면 이쪽이 이긴다.**
   *
   * 이 앱 혼자 돌 때는 위의 `MODEL_DIR` 하나면 된다 — 우리가 받고, 우리가
   * 쓰고, VAD 도 그 안에 같이 둔다. 그런데 bento 스택에 얹히면 모양이 다르다:
   * `bootstrap.sh` 가 호스트에서 미리 받아 `data/voice-models` 에 풀고,
   * compose 가 그것을 **읽기 전용**으로 `/models` 에 물린다. 그 안은
   *
   *     /models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/  ← 모델 파일들
   *     /models/silero_vad.onnx                              ← VAD 는 한 칸 위
   *
   * 이라 **VAD 가 모델 폴더 안에 없다.** 그래서 자리를 둘로 갈라 받는다.
   * 설치 마법사가 적어 주는 이름이 이 둘이다 (`MailBento/setup/server.js`).
   *
   * 이 값이 있으면 `fetch-model.mjs` 는 내려받지 않는다 — 읽기 전용이라 쓸 수도
   * 없고, 이미 호스트가 받아 둔 671MB 를 한 번 더 받을 이유도 없다.
   */
  ASR_MODEL_DIR: z.string().optional(),

  /**
   * 어느 전사 모델을 쓰는가. 서술자의 id (`scripts/asr-models.json`).
   *
   * 비우면 표의 기본값(parakeet)이다. **모르는 id 를 적으면 앱이 뜨지
   * 않는다** — 조용히 기본값으로 떨어지면, 한국어 모델을 붙였다고 믿는
   * 사람이 여전히 한국어를 못 하는 앱을 쓰게 되고 그 사실이 화면 어디에도
   * 안 나온다 (`asr-models.ts` 의 `getModel`).
   *
   * 모델 **파일**은 이 값과 무관하게 `ASR_MODEL_DIR`/`MODEL_DIR` 에서 찾는다.
   * 서술자는 그 폴더 **안의 파일 이름**만 정한다.
   */
  ASR_MODEL_ID: z.string().trim().optional(),

  /**
   * silero VAD 파일. 없으면 모델 폴더 안에서 찾는다.
   *
   * 갈라 둔 이유는 위와 같다 — 스택 배포에서 VAD 는 모델 폴더 **밖에** 있다.
   */
  VAD_MODEL_PATH: z.string().optional(),

  /**
   * 화자 분리 모델(분할 + 임베딩) 두 개가 있는 자리. 합 34.3MB.
   *
   * **`ASR_MODEL_DIR` 에서 짐작하지 않는다.** 스택 배포에서 전사 모델은
   * `/models/sherpa-onnx-nemo-parakeet-…` 안에 있고 VAD 는 한 칸 위에 있다.
   * 분리 모델이 어느 칸에 앉을지는 `bootstrap.sh` 가 정하는 것이지 여기서
   * `..` 를 붙여 맞힐 일이 아니다 — 맞히려 들면, 스택이 아직 분리 모델을
   * 모르는 배포에서 **읽기 전용 자리에 쓰다 EROFS 로 죽는다.**
   *
   * 그래서 이 값을 비워 두면 `MODEL_DIR`(도커에서 /app/data/models, 우리가
   * 쓸 수 있는 볼륨)에 받는다. 그 편이 좋은 성질을 하나 준다 — **이미 돌고
   * 있는 스택이 설정 한 줄 안 바꾸고도 화자 분리를 갖게 된다.** 34.3MB 라
   * 볼륨에 부담도 아니다 (전사 모델이 671MB 다).
   *
   * 값이 있으면 `fetch-model.mjs` 는 내려받지 않고 **있는지만 본다.**
   */
  DIAR_MODEL_DIR: z.string().optional(),

  /**
   * 어느 화자 분리 모델을 쓰는가. 서술자의 id (`scripts/diar-models.json`).
   *
   * 비우면 표의 기본값(pyannote-segmentation-3.0 + CAM++)이다. `ASR_MODEL_ID`
   * 와 같은 규율으로 **모르는 id 를 적으면 앱이 뜨지 않는다.**
   *
   * 갈아 끼울 것이 실질적으로 임베딩뿐인 까닭은 `diar-models.ts` 첫머리에
   * 적혀 있다. 한 가지만 여기 옮겨 적어 둔다: **한국어 전사 모델로 바꾸는
   * 날 이 값은 손댈 것이 없다.** 임베딩은 낱말이 아니라 목소리의 성질을
   * 재므로 말과 무관하다.
   */
  DIAR_MODEL_ID: z.string().trim().optional(),

  /**
   * 분리에 쓸 스레드 수. 비우면 서술자의 기본값(4).
   *
   * 이름이 하나뿐인 것은 `ASR_THREADS`/`ASR_NUM_THREADS` 와 달리 이 값을
   * 적어 둔 설치 마법사가 아직 없기 때문이다. 새로 만드는 이름이니 둘로
   * 나눌 이유가 없다.
   */
  DIAR_THREADS: z.coerce.number().int().min(1).max(16).optional(),

  /**
   * 업로드 1건당 최대 크기 (MB). 조각 전송이라 메모리와 무관하게 키울 수 있다.
   * 한 시간짜리 영상이 몇 GB 가 되는 일이 흔하다.
   */
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(51200).default(5120),

  // ── 파일 손잡이: MemoBento ──────────────────────────────────
  /**
   * 올린 파일이 실제로 사는 곳.
   *
   * 이 앱은 파일 저장소를 따로 두지 않는다. 올라온 조각을 MemoBento 의 예약
   * 메모함으로 그대로 흘려보내고, 여기에는 `fileId` 만 남는다. 재생도 그쪽
   * 파일 라우트로 프록시한다 (Range 를 그대로 실어서).
   *
   * **주소를 이을 때 `new URL("/api/…", base)` 를 쓰지 마라.** 절대 경로가
   * base 의 `/memo` 를 통째로 버린다 — `lib/memobento.ts` 의 `join()` 을 쓴다.
   */
  MEMOBENTO_URL: z.string().optional(),

  /**
   * **서버가** MemoBento 를 부를 때 쓰는 주소. 있으면 이쪽이 이긴다.
   *
   * 위의 `MEMOBENTO_URL` 과 갈라 두는 이유가 있다. 그 값은 **사람이 누르는
   * 버튼**의 주소라 바깥 주소여야 한다 (`https://bento.…/memo`). 그런데 이
   * 앱의 서버는 같은 도커 네트워크 안에서 `http://memobento:3000` 으로
   * 곧바로 닿는다.
   *
   * 하나로 합치면 파일을 주고받는 요청이 **터널을 한 바퀴 돌아 나갔다
   * 들어온다.** 느린 것으로 끝나지 않는다 — Cloudflare 무료 플랜의 업로드
   * 100MB 한계에 걸리고, Access 가 앞을 막으면 로그인 화면 HTML 을 받아 든다.
   * 한 시간짜리 녹음은 대개 그 한계를 넘는다.
   *
   * 설치 마법사가 이 이름으로 적어 준다 (`MailBento/setup/server.js`).
   */
  MEMOBENTO_API_URL: z.string().optional(),

  /** MemoBento 의 `AUTH_PASSWORD`. 인증이 꺼진 배포라면 비워 둔다. */
  MEMOBENTO_PASSWORD: z.string().optional(),
  /**
   * 파일을 넣을 메모함.
   *
   * 비우면 `MEMOBENTO_NOTEBOOK_KEY` 로 찾는다. 배포 담당이 MemoBento 에
   * 예약 메모함을 만들기 전이라면 여기에 기존 메모함 id(예: `sys-agent-inbox`)
   * 를 적어 두면 그때까지도 돈다.
   */
  MEMOBENTO_NOTEBOOK_ID: z.string().optional(),
  /** 예약 메모함의 `system_key`. MemoBento 쪽에 이 키가 생기면 저절로 찾아진다. */
  MEMOBENTO_NOTEBOOK_KEY: z.string().default("voice"),

  // ── 자매 앱 링크 (선택) ────────────────────────────────────
  /**
   * 머리말에서 형제 앱으로 건너가는 버튼의 주소.
   *
   * 비우면 화면이 지금 접속한 호스트에서 유추한다. 한 도메인을 경로로 나눠
   * 쓰는 배포(`/mail`·`/memo`·`/paper`)에서는 그 유추가 맞지 않으니 전체
   * 주소를 적어야 한다.
   */
  MAILBENTO_URL: z.string().optional(),
  PAPERBENTO_URL: z.string().optional(),

  // ── 전사 ───────────────────────────────────────────────────
  /**
   * 동시에 돌릴 전사 개수. **기본 1.**
   *
   * 근거는 두 가지다.
   *
   * 1. **CPU.** uno 는 물리 4코어다. 워커 하나가 이미 `numThreads: 4` 로 그
   *    넷을 다 쓴다(실측: 1스레드 97.5s · 2스레드 67.3s · 4스레드 57.0s ·
   *    8스레드 78.7s / 10분 오디오). 둘을 나란히 돌리면 전체 처리량은 그대로
   *    인데 각자가 두 배로 느려지고, 먼저 올린 사람이 먼저 끝나지도 않는다.
   *    10분짜리 둘을 예로 들면 — 차례로 돌릴 때 57초·114초(평균 85초),
   *    나란히 돌릴 때 둘 다 134초(평균 134초)다. 나란히가 모든 면에서 진다.
   * 2. **메모리.** 워커 하나가 최고 1.6GB 를 쓴다(60분 오디오, VAD 경로).
   *    uno 의 여유가 12GB 라 둘까지는 들어가지만, 그 여유는 형제 앱 넷과
   *    에이전트가 함께 쓰는 것이다.
   *
   * 그래서 기본은 줄을 세운다. 짧은 녹음이 긴 것 뒤에서 기다리는 것이
   * 정말 거슬리는 배포라면 2로 올릴 수 있게 열어 둔다 (2×1.6=3.2GB).
   * 3이 상한인 것은 그 위로는 메모리가 아니라 스왑을 건드리기 때문이다.
   */
  TRANSCRIBE_CONCURRENCY: z.coerce.number().int().min(1).max(3).default(1),

  /**
   * 조각마다 쓸 스레드 수. **바꿀 이유가 없다.**
   *
   * 위의 실측 그대로 4가 가장 빠르다. 8은 2보다도 느리다(물리 4코어에
   * 논리 8이라 하이퍼스레드끼리 캐시를 두고 싸운다). 다른 기계에 옮길 때만
   * 손댈 값이라 열어는 둔다.
   *
   * **기본값을 여기 적지 않는다.** 적정 스레드 수는 모델의 성질이라
   * 서술자에 있다 (`asr-models.json` 의 `defaultThreads`). 여기에 `4` 를
   * 박아 두면 다른 모델을 붙였을 때 그 모델의 값이 조용히 무시된다.
   * 비워 두는 것이 "서술자에게 맡긴다" 는 뜻이다.
   */
  ASR_NUM_THREADS: z.coerce.number().int().min(1).max(16).optional(),

  /**
   * 위와 같은 값의 다른 이름. **설치 마법사가 적는 것이 이쪽이다.**
   *
   * 이름이 둘인 것은 좋지 않지만, 한쪽을 지우는 것이 더 나쁘다 —
   * `MailBento/setup/server.js` 가 `voicebento.env` 에 `ASR_THREADS` 를 적고,
   * 그 파일은 이미 사람의 서버에 만들어져 있을 수 있다. 이 앱만 이름을 바꾸면
   * 그날부터 그 값이 조용히 무시되고 기본값 4가 쓰인다 — 지금은 그게 같은
   * 값이라 아무도 못 알아챈다. 다른 기계로 옮겨 8로 적는 날에야 드러난다.
   * 그래서 둘 다 받고, 마법사가 적은 쪽을 먼저 본다 (`asrThreads`).
   */
  ASR_THREADS: z.coerce.number().int().min(1).max(16).optional(),

  /**
   * ffmpeg 실행 파일.
   *
   * 도커 이미지에는 정적 바이너리 하나가 `/usr/local/bin/ffmpeg` 에 있다
   * (`mwader/static-ffmpeg` 에서 복사, 135MB). Debian 의 `apt install ffmpeg`
   * 은 +648MB 라 쓰지 않는다. `ffprobe` 는 넣지 않았다 — 길이는 정규화한
   * WAV 의 표본 수에서 정확히 나온다.
   */
  FFMPEG_PATH: z.string().default("ffmpeg"),

  /**
   * 에이전트 입구가 한 번에 받는 본문의 상한 (KB).
   *
   * 전사문 전체를 한 덩어리로 넘기므로 이 값에 걸릴 수 있다. 한 시간짜리
   * 회의가 글자로 수만 자라 대개는 안쪽이지만, **넘치면 조용히 자르지 않고
   * 그렇다고 말한다** (`/polish` 가 413 을 준다).
   */
  AGENT_MAX_BODY_KB: z.coerce.number().int().positive().default(512),

  /**
   * 세션 하나가 에이전트 맥락에 부을 수 있는 글자 수의 상한.
   *
   * ## 왜 상한이 필요한가
   *
   * 세션은 claude 세션 하나에 `--resume` 으로 이어 붙는다. 녹음을 더할
   * 때마다, 대화를 한 번 주고받을 때마다 그 세션의 기록이 길어지고, 그것은
   * **줄어들지 않는다.** 언젠가 모델의 맥락 창을 넘고, 그때 나는 오류는
   * "이 세션은 너무 큽니다" 가 아니라 CLI 가 뱉는 알아볼 수 없는 실패다.
   *
   * ## 왜 600,000 인가
   *
   * 영어는 4글자쯤이 토큰 하나다 — 60만 자면 15만 토큰쯤이고, 답과 안내문이
   * 얹힐 자리를 남긴 값이다. 한 시간짜리 녹음의 전사문이 4만 자쯤이므로
   * (`lib/agent.ts`), 주간 회의를 열 번 넘게 쌓아도 닿지 않는다.
   *
   * **넘으면 조용히 자르지 않는다.** 세는 곳과 거절하는 곳은
   * `lib/session-server.ts` 에 있다.
   */
  SESSION_CONTEXT_CHARS: z.coerce.number().int().positive().default(600_000),

  // ── 인증 ───────────────────────────────────────────────────
  /**
   * 인증 설정 — 둘 다 비우면 인증 비활성 (앱 그대로 공개).
   * - AUTH_PASSWORD: plaintext 또는 bcrypt 해시 ($2a$ / $2b$ 시작). 둘 다 자동 감지.
   * - AUTH_SECRET: 세션 쿠키 암호화 키 (32바이트 base64).
   *   **형제 앱들과 같은 값이어야 한다** — 쿠키 이름을 나눠 쓰기 때문이다
   *   (`lib/auth.ts` 의 설명).
   */
  AUTH_PASSWORD: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export type Env = z.infer<typeof envSchema>;

/**
 * 모델이 실제로 어디 있는가. **경로를 짐작하는 곳은 여기 한 곳뿐이다.**
 *
 * 위의 `ASR_MODEL_DIR`·`VAD_MODEL_PATH` 설명에 적었듯 배포 모양이 둘이다.
 * 그 갈림길을 부르는 쪽마다 다시 쓰면 언젠가 한 곳만 고치고, 그날 전사는
 * "모델 파일이 없습니다" 로 죽는다 — 화면에는 파일이 잘못된 것처럼 보인다.
 *
 * `managed` 는 **이 자리에 우리가 내려받아도 되는가**이다. 스택이 물려 준
 * 자리는 읽기 전용이라 쓰면 안 되고, 쓸 필요도 없다 (호스트가 이미 받아 뒀다).
 */
export const modelPaths = (() => {
  const dir = env.ASR_MODEL_DIR?.trim() || env.MODEL_DIR;
  const managed = !env.ASR_MODEL_DIR?.trim();
  // VAD 를 따로 안 줬으면 모델 폴더 안에 있다고 본다 (이 앱이 직접 받은 경우).
  const vad = env.VAD_MODEL_PATH?.trim() || `${dir.replace(/[/\\]$/, "")}/silero_vad.onnx`;
  return { dir, vad, managed };
})();

/**
 * 지금 쓰는 전사 모델의 서술자. **모델의 성질을 묻는 곳은 여기 하나다.**
 *
 * 모듈 껍데기에서 한 번 읽는다 — 서술자의 불변식 검사(`assertModel`)가 그때
 * 돈다. 어긋나 있으면 앱이 안 뜨고, 그 편이 전사가 조용히 틀린 글을 내는
 * 것보다 낫다 (`asr-models.ts` 의 설명).
 */
export const asrModel = getModel(env.ASR_MODEL_ID || DEFAULT_MODEL_ID);

/**
 * 조각마다 쓸 스레드 수.
 *
 * 순서가 셋이다: 설치 마법사가 적는 `ASR_THREADS` → 사람이 적은
 * `ASR_NUM_THREADS` → **서술자의 기본값.** 마지막을 서술자에 둔 것은 적정
 * 스레드 수가 기계가 아니라 모델의 성질이기 때문이다.
 */
export const asrThreads =
  env.ASR_THREADS ?? env.ASR_NUM_THREADS ?? asrModel.runtime.defaultThreads;

/**
 * 지금 쓰는 화자 분리 모델의 서술자. **분리 모델의 성질을 묻는 곳은 여기 하나다.**
 *
 * 모듈 껍데기에서 한 번 읽는다 — 서술자의 불변식 검사(`assertDiarModel`)가
 * 그때 돈다. 라이선스 허용 목록, `windowShiftRatio` 상한, `clusterMargin`
 * 하한, 길이 상한과 메모리 예산의 짝이 거기서 걸린다. 어긋나 있으면 앱이
 * 안 뜨고, 그 편이 분리가 조용히 틀린 이름을 붙이는 것보다 낫다.
 *
 * **모델 파일이 없는 것은 여기서 안 본다.** 그건 서술자의 잘못이 아니고,
 * 무엇보다 전사문이 화자 분리보다 먼저다 — 파일이 없으면 화자 구분만 못 하고
 * 전사는 그대로 돈다.
 */
export const diarModel = getDiarModel(env.DIAR_MODEL_ID || DEFAULT_DIAR_MODEL_ID);

/**
 * 화자 분리 모델이 실제로 어디 있는가. **위 `modelPaths` 와 갈라 둔다.**
 *
 * 갈라 두는 근거는 `DIAR_MODEL_DIR` 설명에 있다 — 요는 `ASR_MODEL_DIR` 에서
 * 분리 모델 자리를 짐작하지 않는다는 것이다.
 *
 * `seg`·`emb` 는 **모델 서술자가 정한 이름**으로 이은 것이다. 부르는 쪽이
 * 파일 이름을 다시 적으면, 모델을 갈아 끼울 때 서술자만 고치고 그 자리는
 * 옛 이름을 계속 가리킨다. 그러면 분리는 "파일이 없습니다" 로 죽는데 화면에는
 * 내려받기가 실패한 것처럼 보인다.
 *
 * `managed` 는 **이 자리에 우리가 내려받아도 되는가**이다 (스택이 물려 준
 * 자리는 읽기 전용이다).
 */
export const diarPaths = (() => {
  const dir = (env.DIAR_MODEL_DIR?.trim() || env.MODEL_DIR).replace(/[/\\]$/, "");
  const managed = !env.DIAR_MODEL_DIR?.trim();
  return {
    dir,
    managed,
    seg: `${dir}/${diarModel.segmentation.name}`,
    emb: `${dir}/${diarModel.embedding.name}`,
  };
})();

/**
 * 분리에 쓸 스레드 수. 사람이 적은 값 → **서술자의 기본값.**
 *
 * `asrThreads` 와 같은 결이다 — 적정 스레드 수는 기계가 아니라 모델의
 * 성질이라 마지막 자리를 서술자에 둔다.
 */
export const diarThreads = env.DIAR_THREADS ?? diarModel.runtime.defaultThreads;
