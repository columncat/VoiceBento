# VoiceBento

소리와 영상을 올리면 전사문으로 바꿔 두고, 눌러 들으며 고쳐 읽는 자리.
`MailBento` · `MemoBento` · `PaperBento` 와 한 스택에서 도는 다섯째 앱이다.

- 소리든 영상이든 올리면 된다. 영상이면 오디오 트랙만 뽑아 쓴다.
- 전사는 **sherpa-onnx + NVIDIA parakeet-tdt-0.6b-v3 (int8)** 이 한다. CPU 만 쓴다.
- 전사문은 BentoAgent 가 한 번 더 다듬는다. **화자도 대사에서 추정한다** —
  화자 분리 모델을 쓰지 않는다.
- 타임스탬프를 누르면 그 시각으로 재생이 뛴다. 전사문은 손으로 고칠 수 있고,
  고친 줄은 다시 다듬어도 덮이지 않는다.

## ⚠️ 한국어는 못 알아듣습니다

이 앱이 쓰는 전사 모델(`parakeet-tdt-0.6b-v3`)의 어휘 8,193개에는 **한글이
하나도 없습니다.** 한국어 소리를 넣으면 오류가 나지 않고 **빈 글이나 엉뚱한
로마자**가 나옵니다. 영어를 비롯한 유럽 25개 언어용입니다.

알고 고른 선택입니다. 앱은 결과가 그 모양일 때 화면에 그 사실을 알려 줍니다.

## 어떻게 도는가

```
브라우저 ──8MB 조각──▶ VoiceBento ──그대로──▶ MemoBento (파일이 사는 곳)
                          │
                          │ 전사 줄 세우기 (기본 동시 1건)
                          ▼
                    자식 프로세스: scripts/transcribe.mjs
                      ffmpeg → 16kHz 모노 WAV
                      silero VAD (조각 최대 30초)
                      조각마다 parakeet 디코딩 (numThreads 4)
                          │ 조각 하나 끝날 때마다 stdout JSON 한 줄
                          ▼
                        SQLite (segments)
                          │
                          ▼
                    BentoAgent /voice/polish  ← 다듬기 · 화자 추정
```

**파일은 이 앱에 없다.** 올라온 조각은 MemoBento 의 예약 메모함으로 그대로
흘러가고, 이 앱은 `fileId` 만 들고 있다. 재생도 그쪽 파일 라우트로 프록시한다
(Range 를 그대로 넘겨서 `<audio>` 의 탐색이 그대로 된다).

**전사는 반드시 자식 프로세스에서 돈다.** `sherpa-onnx-node` 의 C++ 예외는
N-API 를 넘으며 `std::terminate()` 를 부른다 — `try/catch` 로도
`uncaughtException` 으로도 안 잡히고 프로세스가 SIGABRT 로 죽는다. Next 서버
안에서 돌리면 긴 파일 하나가 앱 전체를 죽인다.

## 속도 (uno 실측: i5-8365UE 4코어, GPU 없음)

| 길이 | 걸린 시간 | 최고 메모리 |
| --- | --- | --- |
| 1분 | 6.0초 | |
| 10분 | 57초 | |
| 60분 | 5분 46초 | 1.60GB |

RTF ≈ 0.096. 모델 적재 2.4~5.8초.

## 띄우기

```bash
npm install          # 앱
npm run asr:install  # 전사 워커의 네이티브 의존성 (플랫폼별 수백 MB)
npm run model:fetch  # 모델 671MB 를 MODEL_DIR 에 (있으면 건너뜀)
cp .env.example .env.local   # 값을 채운다 (MEMOBENTO_URL 은 필수)
npm run dev
```

ffmpeg 이 `PATH` 에 있어야 한다 (도커 이미지에는 정적 바이너리가 들어 있다).

도커로 띄우면 진입점이 모델을 알아서 챙긴다. 모델은 **이미지에 굽지 않고
볼륨에 둔다** — 구우면 런타임 이미지가 1.7GB 가 된다.

### bento 스택에 얹을 때

혼자 돌 때와 환경변수가 다르다. 스택은 모델을 호스트에서 미리 받아
**읽기 전용**으로 물리고, 앱은 아무것도 내려받지 않는다.

| 값 | 뜻 |
| --- | --- |
| `ASR_MODEL_DIR` | 모델 폴더. 있으면 `MODEL_DIR` 을 이기고, 내려받지 않는다 |
| `VAD_MODEL_PATH` | silero VAD 파일. 스택에서는 모델 폴더 **밖**에 있다 |
| `MEMOBENTO_API_URL` | **서버가** 파일을 주고받을 주소 (`http://memobento:3000`) |
| `MEMOBENTO_URL` | **사람이 누르는** 버튼의 바깥 주소 (`https://…/memo`) |
| `ASR_THREADS` | `ASR_NUM_THREADS` 의 다른 이름. 설치 마법사가 적는 쪽 |

`MEMOBENTO_URL` 과 `MEMOBENTO_API_URL` 을 **하나로 합치지 마라.** 바깥 주소로
파일을 나르면 요청이 터널을 한 바퀴 돌아 나갔다 들어오면서 Cloudflare 무료
플랜의 업로드 100MB 한계와 Access 로그인 화면을 만난다. 한 시간짜리 녹음은
대개 그 한계를 넘는다.

컨테이너는 **안에서 3000 번을 듣는다** (형제 앱들과 같다). 호스트 3003 은
compose 가 잇는다: `"${VOICEBENTO_PORT:-3003}:3000"`.

## 라이선스

코드는 **MIT**. 실행 중에 내려받는 모델 가중치는 다르다 —
`nvidia/parakeet-tdt-0.6b-v3` 는 **CC-BY-4.0** 이라 **출처 표시 의무**가 있고,
sherpa-onnx 계열은 Apache-2.0 이다. 자세한 것은 [LICENSE](./LICENSE).
