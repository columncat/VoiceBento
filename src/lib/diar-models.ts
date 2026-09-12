import table from "../../scripts/diar-models.json";

/**
 * 화자 분리 모델 서술자 — **분리 모델의 성질을 아는 유일한 자리.**
 *
 * 옆의 `asr-models.ts` 와 같은 결이고 같은 이유로 있다. 사실은
 * `scripts/diar-models.json` 한 곳에 적고, **문장과 불변식은 여기서 만든다.**
 * 왜 `scripts/` 냐는 그쪽 파일의 설명을 보라 (런타임 이미지에 파일로
 * 복사되는 것이 거기뿐이다).
 *
 * ## 지금까지는 소리를 안 들었다
 *
 * 화자 구분을 **에이전트가 대사만 보고 추정**했다. "이 말투는 아까 그
 * 사람이겠지" 다. 그것이 틀리는 자리가 보이지 않는 것이 문제였다 — 사람이
 * 보기에 그럴듯한 이름이 붙어 있으니 맞았는지 틀렸는지를 가릴 방법이 없다.
 *
 * 이제 소리로 가른다. 분할 모델이 "언제 누가 말했나" 를 자르고, 임베딩
 * 모델이 그 토막의 목소리를 192차원 벡터로 재고, 그 벡터를 뭉쳐 무리를
 * 만든다. **이름은 여전히 에이전트가 붙인다** — 음향은 "1번 2번 3번" 까지만
 * 말할 수 있고, 그 1번이 누구인지는 대사에 있다.
 *
 * ## 한국어 모델로 갈아탈 때 무엇이 바뀌나 — **아무것도 안 바뀐다**
 *
 * 이 설계의 전제가 그것이다. 전사 모델을 parakeet(한국어 못함)에서 한국어를
 * 하는 것으로 바꾸는 날, 여기서 고칠 것이 없다.
 *
 * **안 바뀌는 것 (전부다):**
 * - 분할 모델. 말이 있는 자리와 화자가 바뀌는 자리를 찾을 뿐 무슨 말인지
 *   보지 않는다. 학습에 쓴 말이 무엇이든 상관없다.
 * - 임베딩 모델. **목소리의 성질**(성도의 모양, 기본 주파수, 울림)을 재지
 *   낱말을 재지 않는다. 이름의 `zh_en` 은 학습 자료의 말이지 쓸 수 있는 말이
 *   아니다 — 실제로 이 앱의 근거가 된 실측은 **영어 회의(AMI 9편)** 로 잰
 *   것이고 모델 이름에는 영어가 뒤에 붙어 있다. 둘째 칸의 ERes2NetV2 는
 *   이름이 `zh-cn` 뿐인데도 같은 자리에 놓인다.
 * - 군집 수 규칙(k = 목록 인원 + 2), `windowShiftRatio` 0.1,
 *   `minDurationOn`/`Off`, 메모리 기울기, 실루엣 문턱. 전부 소리 쪽 값이다.
 * - 오디오 모양: 16kHz 모노. 전사 워커가 이미 그렇게 정규화한다.
 *
 * **바뀌는 것 (분리 바깥이다):**
 * - 낱말에 화자를 붙이는 길. 한국어 모델이 `timestamps: "none"` 이면
 *   (sherpa-onnx 의 whisper 가 그렇다) 낱말 시각이 없어 글자 수로 조각을
 *   나눠 붙인다. AMI 에서 재니 낱말 단위 73.5% 대신 **68.4%** 다 — 얻는 것의
 *   56%가 남는다. 조각 통째(61.9%)보다는 여전히 낫다. 그 갈림길은
 *   `asr-models.ts` 의 `timestamps` 칸이 이미 말해 준다.
 * - 화면과 에이전트에 뜨는 말. 그것도 서술자에서 만든다.
 *
 * 그래서 한국어로 가는 날 이 파일은 열지 않아도 된다. 그 사실을 여기 적어
 * 두는 이유는, 적어 두지 않으면 "임베딩도 한국어 것으로 바꿔야 하나" 를
 * 그때 가서 다시 알아보기 때문이다.
 *
 * ## 모델을 하나 더 붙이려면
 *
 * 1. `scripts/diar-models.json` 의 `files` 에 파일 한 칸 (**실제로 받아
 *    확인한** 주소·크기·sha256·라이선스).
 * 2. 같은 파일의 `models` 에 서술자 한 칸.
 * 3. `DIAR_MODEL_ID` 로 고른다.
 *
 * 라이선스가 허용 목록에 없으면 **앱이 안 뜬다.** 그 규율의 근거는 JSON 의
 * `licenseAllowlist` 칸에 적혀 있다 (한 줄로: 저장소가 공개이고 /voice 는
 * hosted service 다).
 */

// ─────────────────────────────────────────────────────────────
//   모양
// ─────────────────────────────────────────────────────────────

/**
 * 파일 하나를 어떻게 받는가.
 *
 * - `"direct"` — .onnx 하나가 그대로 올라와 있다. 받는 것이 곧 쓰는 것이라
 *   크기·해시를 따로 안 적는다 (파일 칸의 것이 그것이다).
 * - `"archive"` — `.tar.bz2` 안에 들어 있다. 묶음의 크기·해시와 꺼낼 멤버
 *   이름이 따로 있다. **묶음과 멤버를 둘 다 검사한다** — 묶음만 보면 tar 이
 *   엉뚱한 멤버를 꺼내도 모르고, 멤버만 보면 몇 MB 를 다 받고 나서야 안다.
 */
export type DiarDownload =
  | { kind: "direct"; url: string }
  | { kind: "archive"; url: string; size: number; sha256: string; member: string };

export interface DiarFile {
  /** 폴더에 앉힐 이름. 묶음 안의 이름과 다를 수 있다 (`model.onnx` 는 너무 흔하다). */
  name: string;
  size: number;
  sha256: string;
  /** SPDX 식별자. `licenseAllowlist` 에 없으면 앱이 안 뜬다. */
  license: string;
  credit: {
    weights: string;
    weightsLicense: string;
    /** 있으면 그대로 실어야 하는 저작권 표시 (MIT 의 의무). */
    copyright?: string;
    export: string;
    exportLicense: string;
  };
  download: DiarDownload;
}

/**
 * 워커에게 넘기는 조각. **JSON 으로 직렬화해 argv 로 간다.**
 *
 * 왜 워커가 제 손으로 표를 안 읽는지는 `asr-models.ts` 의 같은 자리에 적혀
 * 있다 — 부모가 고르고 워커는 따른다. 여기 담기는 것은 전부 공개해도 되는
 * 사실이다 (argv 는 호스트 `ps` 에 그대로 보인다).
 */
export interface DiarRuntimeSpec {
  id: string;
  /** 16000 만 된다. 아래 불변식을 보라. */
  sampleRate: number;
  defaultThreads: number;

  /**
   * 분할 모델의 창을 얼마씩 밀며 훑는가. **0.1 이다. 올리지 마라.**
   *
   * 0.25 로 재면 60분 이상에서 **4편 중 0편**이 쓸 만했다. 그리고 이 값은
   * 서서히 나빠지지 않는다 — DER 이 3~4% 아니면 20~25% 로, 둘 중 하나다.
   * 중간이 없다는 것이 고약하다: 짧은 파일 몇 개로 시험하면 0.25 가 멀쩡해
   * 보이고, 한 시간짜리 진짜 회의에서만 무너진다. 그때 나오는 것은 오류가
   * 아니라 **그럴듯하게 틀린 화자 표시**다.
   *
   * 값이 작을수록 촘촘히 훑어 느리지만 안전하다. 그래서 불변식은 상한만 건다.
   */
  windowShiftRatio: number;

  /** 이보다 짧은 말 토막은 버린다 (초). */
  minDurationOn: number;
  /** 이보다 짧은 침묵은 말을 끊지 않는다 (초). */
  minDurationOff: number;

  /**
   * 사람이 적어 준 이름 수 L 에 **더해서** 만들 무리 수. `k = L + clusterMargin`.
   *
   * ## 왜 L 이 아닌가
   *
   * 사람이 셋이라고 적으면 무리도 셋을 만드는 것이 자연스러워 보인다.
   * 그게 틀렸다는 것을 두 자리에서 확인했다.
   *
   * AMI 9편(정답 화자 4명, 목록도 4명): k=4 면 적은 사람들 정확도 63.6% ·
   * DER(c.25) 28.0%. k=6 이면 **70.6% · 19.4%** 다. +7.0pt, DER −8.6pt.
   *
   * 그리고 **사용자의 진짜 녹음에서 재현됐다.** 녹음 한 편(21분 26초, 3명)에 k=3 을
   * 주니 셋째 사람의 낱말 197개가 **197개 전부** 둘째 사람에게 붙고, 남은
   * 셋째 자리는 18초짜리 부스러기가 가져갔다.
   *
   * ## 왜 그런가
   *
   * 무리 하나는 한 사람이 아니라 "비슷하게 들리는 것들" 이다. 진짜 회의에는
   * 기침·웃음·문 여닫는 소리·여러 사람이 겹쳐 말하는 구간이 섞여 있고, 그
   * 부스러기들이 자리를 하나씩 차지한다. k 를 딱 맞춰 주면 사람이 부스러기에
   * 밀려난다. 넉넉히 주면 부스러기가 제 무리를 갖고 사람은 사람끼리 남는다 —
   * 그래서 이름을 나눠 줄 때 **말한 시간 상위 L개**만 이름을 받는다.
   *
   * 값은 거의 공짜다: 21분짜리에서 RSS 338MB → 347MB.
   */
  clusterMargin: number;

  /**
   * 이보다 긴 오디오는 분리하지 않는다 (초). 180분.
   *
   * sherpa 의 `process()` 는 Float32Array 를 **통째로** 받고 메모리가 길이에
   * 선형이다(`memory` 칸). 180분이면 2.0GB 다. 상한이 없으면 세 시간짜리
   * 강연 하나가 컨테이너를 넘어뜨리는데, 그때 죽는 것은 워커 프로세스이므로
   * 전사문까지 함께 사라지지는 않지만 — 그래도 "안 한다" 고 미리 말하는 편이
   * 낫다.
   */
  maxAudioSeconds: number;
}

export interface DiarModel {
  id: string;
  /** 사람이 읽는 이름. 화면에 그대로 적어도 되는 값. */
  name: string;

  /** 언제 누가 말했는지 자르는 모델. */
  segmentation: DiarFile;
  /** 그 토막의 목소리를 재는 모델. **갈아 끼울 수 있는 것은 이쪽뿐이다.** */
  embedding: DiarFile;

  runtime: DiarRuntimeSpec;

  /** 임베딩 벡터의 차원. */
  embeddingDim: number;
  /** 실시간 대비 처리 시간. 기다림을 어림하는 데만 쓴다. */
  rtf: number;

  /**
   * 메모리가 오디오 길이에 **선형**이다. `mbPerMinute × 분 + mbBase`.
   *
   * 60분 705MB · 90분 1,037MB · 120분 1,413MB · 21분 338~347MB — 전부 실측.
   *
   * **이 값은 화자 수를 줬을 때의 것이다.** 안 주면(문턱으로 무리를 정하면)
   * 분당 39MB 로 네 배가 된다. 우리는 언제나 수를 주므로 그 길은 안 쓴다.
   */
  memory: { mbPerMinute: number; mbBase: number; budgetMb: number };

  /**
   * 이 녹음을 통째로 못 믿겠다고 말할 문턱 — **분리 구간 실루엣의 중앙값.**
   *
   * 실루엣 중앙값과 그 파일의 화자 정확도는 Spearman 0.75~0.78 로 붙어
   * 다닌다(합성 11편·AMI 9편·합 20편에서 각각 0.742·0.767·0.778). AMI 9편에
   * 0.25 를 걸면 IB4002 한 편만 걸리는데, 그 편의 정확도가 67.8% 로 9편 중
   * 꼴찌다 — 걸린 것이 실제로 나쁜 것이었다.
   *
   * 원래 쓰려던 신호 **"나온 무리 수 < 요청한 수"** 는 쓰지 마라. AMI 9편에서
   * **0번** 울렸다. 안 울리는 경고는 없는 경고다.
   *
   * 이 눈금은 임베딩 모델마다 다르다. 임베딩을 바꾸면 다시 재야 한다.
   */
  fileWarnSilhouetteMedian: number;

  /**
   * 낱말 단위 실루엣으로 "덜 확실하다" 를 표시할 문턱과 **그 문턱에서의** 실력. 모르면 null.
   *
   * `flagAt` 이 화면의 "덜 또렷" 과 에이전트의 `?` 가 함께 쓰는 **단 하나의**
   * 문턱이다 (`speaker-doubt.ts`). 숫자 셋은 그 문턱(−0.2)에서 **낱말 단위로**
   * 잰 것이다 — 정밀도 80.4% · 재현율 7.7% · 표시 2.5%. 한 편씩 빼고 고른
   * 문턱으로도 79.0% · 6.9% · 2.3% 라 과적합이 아니다. 문턱을 바꾸면 숫자도
   * 다시 재서 함께 고쳐라 — 짝이 어긋나면 에이전트에게 가는 문장이 거짓이 된다.
   *
   * **이것으로 "틀렸다" 고 말하면 안 된다.** 표시된 낱말 다섯에 하나는 멀쩡하고,
   * 틀린 낱말의 대부분에는 표시가 없다. 그리고 **줄 단위로는 잰 적이 없다.**
   *
   * 조각 단위 실루엣은 아예 죽었다(합성에서 정밀도 100% 였던 것이 AMI 에서
   * 50% 다). 한 낱말만 튄 것(isSingle)도 AUC 0.505 — 동전 던지기다. 쓰지 마라.
   */
  wordSilhouette: {
    auc: number;
    flagAt: number;
    precision: number;
    recall: number;
    flagRate: number;
  } | null;

  /**
   * 낱말을 잇따라 볼 때 화자를 갈아타는 데 매기는 값 (HMM).
   *
   * 낱말마다 따로 정하면 한 낱말짜리 섬이 생긴다. 이 값 하나로 231개가
   * 74개가 되고 정확도가 +0.5pt 오른다.
   *
   * **다른 다듬는 규칙은 쓰지 마라.** 최빈값으로 조각을 통일하는 것도,
   * 짧은 덩어리를 이웃에 흡수시키는 것도 정확도를 깎는다. 튐이 무서워
   * 보이지만 실제로는 **정답이 우리보다 더 자주 바꾼다** — 조각 안에서
   * 정답 2,043번 대 우리 1,315번, 한 낱말 섬도 정답 190개 대 우리 100개다.
   */
  switchPenalty: number;

  /** 에이전트에게 알릴 것. 울타리 없이 실리므로 **여기 적힌 글만** 간다. */
  agentNotes: string[];

  /** 출처 고지. **장식이 아니라 의무다** (분할 모델이 MIT — 저작권 표시를 실어야 한다). */
  attribution: string;
}

// ─────────────────────────────────────────────────────────────
//   표 읽기 — 불변식을 여기서 건다
// ─────────────────────────────────────────────────────────────

interface RawModel {
  id: string;
  name: string;
  segmentationFile: string;
  embeddingFile: string;
  runtime: DiarRuntimeSpec;
  embeddingDim: number;
  rtf: number;
  memory: DiarModel["memory"];
  fileWarnSilhouetteMedian: number;
  wordSilhouette: DiarModel["wordSilhouette"];
  switchPenalty: number;
  agentNotes: string[];
  attribution: string;
}

interface DiarTable {
  default: string;
  files: Record<string, DiarFile>;
  models: Record<string, RawModel>;
  licenseAllowlist: { allowed: string[] };
}

/*
 * JSON 에는 `$comment` 설명 칸이 섞여 있다 (주석을 못 다는 형식이라).
 * 읽는 쪽은 무시하면 되므로 모양만 맞춰 받는다.
 */
const TABLE = table as unknown as DiarTable;

/**
 * 서술자가 스스로 어긋나 있지 않은지 **뜰 때 한 번** 본다.
 *
 * 어긋나면 앱을 세운다. 이 규율은 `asr-models.ts` 에서 가져온 것이고 이유도
 * 같다 — 분리가 조용히 틀린 화자 이름을 붙이는 것보다 앱이 안 뜨는 편이
 * 낫다. 틀린 이름은 화면 어디에도 "틀렸다" 고 안 나온다.
 *
 * 단, **여기서 세우는 것은 서술자의 잘못뿐이다.** 모델 파일이 없는 것은
 * 서술자의 잘못이 아니므로 여기서 안 본다 — 파일이 없으면 분리만 못 하고
 * 전사는 된다 (`scripts/fetch-model.mjs` 와 `docker-entrypoint.sh`).
 */
function assertDiarModel(m: DiarModel): DiarModel {
  const r = m.runtime;
  const bad = (why: string): never => {
    throw new Error(`[voicebento] 화자 분리 서술자가 어긋납니다 (${m.id}): ${why}`);
  };

  /*
   * 라이선스. **이 검사가 이 파일에서 가장 중요하다.**
   *
   * 정확도만 보면 Reverb 계열 분리 모델이 더 낫다. 그런데 Rev Non-Production
   * License 가 hosted service 를 금지하고, `/voice` 가 정확히 그것이며,
   * 이 저장소는 공개다. 그 셋이 겹치는 자리에서는 "좋은 모델" 이 아니라
   * "쓰면 안 되는 모델" 이다.
   *
   * 주석으로만 적어 두면 다음에 고르는 사람이 정확도 표만 보고 다시 고른다.
   * 그래서 코드로 막는다.
   */
  for (const [what, f] of [
    ["분할", m.segmentation],
    ["임베딩", m.embedding],
  ] as const) {
    if (!TABLE.licenseAllowlist.allowed.includes(f.license)) {
      bad(
        `${what} 모델 ${f.name} 의 라이선스가 "${f.license}" 입니다. ` +
          `허용: ${TABLE.licenseAllowlist.allowed.join(", ")}. ` +
          `이 앱은 공개 저장소이고 /voice 는 hosted service 라, 그 둘을 막는 라이선스는 ` +
          `쓸 수 없습니다 (scripts/diar-models.json 의 licenseAllowlist).`,
      );
    }
  }

  if (r.sampleRate !== 16000) {
    // 전사 워커가 16kHz 모노로 정규화한 WAV 를 그대로 나눠 쓴다. 다른
    // 표본율을 쓰려면 두 번째 정규화가 있어야 하는데 그런 것은 없다.
    bad(`sampleRate 가 ${r.sampleRate} 입니다. 16000 만 됩니다.`);
  }

  if (!(r.windowShiftRatio > 0) || r.windowShiftRatio > 0.1) {
    // 0.25 는 60분 이상에서 4편 중 0편이었다. 위 `windowShiftRatio` 설명을 보라.
    bad(
      `windowShiftRatio 가 ${r.windowShiftRatio} 입니다. 0 보다 크고 0.1 이하여야 합니다 — ` +
        `0.25 는 60분 넘는 녹음 4편에서 0편만 쓸 만했고, 서서히 나빠지는 것이 아니라 ` +
        `한꺼번에 무너집니다 (DER 3~4% 아니면 20~25%).`,
    );
  }

  if (r.minDurationOff <= 0 || r.minDurationOn <= 0) {
    bad("minDurationOn/Off 는 0 보다 커야 합니다.");
  }

  if (!Number.isInteger(r.clusterMargin) || r.clusterMargin < 1) {
    // k = L 이 실제로 사용자의 녹음을 망가뜨렸다 (셋째 사람의 낱말 197/197
    // 이 둘째 사람에게). 그 값을 다시 넣지 못하게 막는다.
    bad(
      `clusterMargin 이 ${r.clusterMargin} 입니다. 1 이상의 정수여야 합니다 — ` +
        `무리 수를 목록 인원에 딱 맞추면 기침·웃음·겹쳐 말한 구간이 사람의 자리를 빼앗습니다.`,
    );
  }

  /*
   * 길이 상한과 메모리 예산이 서로 맞는가.
   *
   * 두 숫자를 따로 적어 두면 언젠가 "세 시간도 되게 해 주세요" 에 상한만
   * 올린다. 그날 늘어나는 것은 기다림이 아니라 **메모리**이고, 컨테이너가
   * 죽는 것은 그 녹음 하나가 아니라 앱 전체다.
   */
  const peak = estimateRssMb(m, r.maxAudioSeconds);
  if (peak > m.memory.budgetMb) {
    bad(
      `길이 상한 ${(r.maxAudioSeconds / 60).toFixed(0)}분이면 메모리가 ${peak.toFixed(0)}MB 로 ` +
        `예산 ${m.memory.budgetMb}MB 를 넘습니다. 상한을 내리거나, 예산을 올릴 수 있는지 ` +
        `실제로 재 보고 올리세요 (uno 의 여유는 12GB 이고 그것을 형제 앱 넷과 나눠 씁니다).`,
    );
  }

  if (m.embeddingDim <= 0) bad("embeddingDim 이 0 이하입니다.");
  if (m.fileWarnSilhouetteMedian < 0 || m.fileWarnSilhouetteMedian > 1) {
    bad("fileWarnSilhouetteMedian 은 -1~1 사이의 실루엣 값입니다. 0~1 로 적으세요.");
  }
  if (m.wordSilhouette) {
    const w = m.wordSilhouette;
    /*
     * 문턱이 없는 실력표는 **어느 문턱의 실력인지 모르는** 표다. 화면과 에이전트가
     * 제 손으로 문턱을 지으면 둘이 다른 줄을 가리키게 된다 — 실제로 그랬다.
     */
    if (typeof w.flagAt !== "number" || !(w.flagAt >= -1 && w.flagAt <= 1)) {
      bad("wordSilhouette.flagAt 은 -1~1 사이의 실루엣 문턱이어야 합니다 (그 문턱에서 잰 실력과 짝입니다).");
    }
  }

  return m;
}

/** 파일 이름 하나를 꺼낸다. 없는 이름을 가리키면 **기본값으로 안 넘어간다.** */
function getFile(key: string, forModel: string): DiarFile {
  const f = TABLE.files[key];
  if (!f) {
    throw new Error(
      `[voicebento] 화자 분리 서술자(${forModel})가 모르는 파일을 가리킵니다: "${key}". ` +
        `아는 것: ${Object.keys(TABLE.files).join(", ")} (scripts/diar-models.json)`,
    );
  }
  return f;
}

export const DIAR_MODEL_IDS: string[] = Object.keys(TABLE.models);
export const DEFAULT_DIAR_MODEL_ID = TABLE.default;

/**
 * id 로 하나 꺼낸다. 모르는 id 면 **기본값으로 조용히 넘어가지 않는다.**
 *
 * `asr-models.ts` 의 `getModel` 과 같은 이유다 — 오타 난 `DIAR_MODEL_ID` 가
 * 조용히 기본값으로 떨어지면, 다른 임베딩을 붙였다고 믿는 사람이 여전히
 * 예전 것을 쓰게 되고 그 사실이 화면 어디에도 안 나온다.
 */
export function getDiarModel(id: string): DiarModel {
  const raw = TABLE.models[id];
  if (!raw) {
    throw new Error(
      `[voicebento] 모르는 화자 분리 모델 id 입니다: "${id}". ` +
        `아는 것: ${DIAR_MODEL_IDS.join(", ")}. (scripts/diar-models.json)`,
    );
  }
  return assertDiarModel({
    id: raw.id,
    name: raw.name,
    segmentation: getFile(raw.segmentationFile, raw.id),
    embedding: getFile(raw.embeddingFile, raw.id),
    runtime: raw.runtime,
    embeddingDim: raw.embeddingDim,
    rtf: raw.rtf,
    memory: raw.memory,
    fileWarnSilhouetteMedian: raw.fileWarnSilhouetteMedian,
    wordSilhouette: raw.wordSilhouette,
    switchPenalty: raw.switchPenalty,
    agentNotes: raw.agentNotes,
    attribution: raw.attribution,
  });
}

// ─────────────────────────────────────────────────────────────
//   서술자에서 나오는 셈
// ─────────────────────────────────────────────────────────────

/** 이 길이를 분리하면 메모리가 얼마나 드는가 (MB). 선형 — 위 `memory` 설명. */
export function estimateRssMb(m: DiarModel, audioSeconds: number): number {
  return (audioSeconds / 60) * m.memory.mbPerMinute + m.memory.mbBase;
}

/** 이 길이를 분리하는 데 얼마나 걸리는가 (초). 어림일 뿐이다 — 붐비면 늘어난다. */
export function estimateDiarSeconds(m: DiarModel, audioSeconds: number): number {
  return audioSeconds * m.rtf;
}

/** 이 길이를 분리할 수 있는가. */
export function canDiarize(m: DiarModel, audioSeconds: number): boolean {
  return audioSeconds > 0 && audioSeconds <= m.runtime.maxAudioSeconds;
}

/**
 * 사람이 이름 L개를 적었을 때 만들 무리 수. **`L + clusterMargin`.**
 *
 * 근거는 `clusterMargin` 설명에 있다. 한 사람도 안 적었을 때(L=0)까지
 * 이 셈을 쓰면 k=2 가 되는데, 그건 "사람 수를 모른다" 와 다르다 — 수를 아예
 * 안 주면 진짜 회의에서 화자가 **40~134명** 나온다. 그래서 목록이 비면 분리
 * 자체를 안 돌린다 (`ROSTER_MISSING`). 여기서 최소 한 명을 까는 것은 그 문을
 * 누가 빠뜨려도 k 가 뜻 없는 값(2)으로 떨어지지 않게 하는 울타리일 뿐이다.
 */
export function clusterCountFor(m: DiarModel, rosterSize: number): number {
  return Math.max(1, Math.trunc(rosterSize)) + m.runtime.clusterMargin;
}

/**
 * 목록에 없는 사람에게 붙는 이름.
 *
 * **무리를 말한 시간으로 줄 세워 상위 L개에만 이름을 주고 나머지는 이것이다.**
 * 신탁(정답을 아는 쪽)과 0.1pt 이내로 붙는다.
 *
 * **실루엣으로 other 를 고르지 마라.** "덜 확실한 무리를 other 로 치자" 가
 * 자연스러워 보이는데, 그렇게 하면 목록에 적은 사람 말의 30%를 버리고
 * 정확도를 18.6pt 깎는다.
 */
export const OTHER_SPEAKER = "other";

/**
 * 사람에게 보일 안내 — **"모르면 넉넉히 적으세요".**
 *
 * 비대칭이 분명하다. 한 사람을 빠뜨리면 −8.3pt, 한 사람을 더 적으면 +4.1pt.
 * 그러니 화면은 "정확히 몇 명인가요" 가 아니라 이렇게 물어야 한다.
 */
export const ROSTER_HINT =
  "말한 사람을 아는 대로 적어 주세요. 헷갈리면 넉넉히 적는 편이 낫습니다 — " +
  "한 명 빠뜨리는 것보다 한 명 더 적는 쪽이 결과가 좋습니다. " +
  // 화면에 실제로 붙는 이름표 글자를 그대로 적는다. 여기서 '기타' 라고 말하고
  // 전사문에는 `other` 가 뜨면 사람은 둘이 같은 것인 줄 모른다.
  `목록에 없는 사람은 '${OTHER_SPEAKER}' 로 묶입니다.`;

/**
 * 목록이 없어 **자동 분리를 돌리지 않았을 때** 화면에 뜨는 말.
 *
 * ## 왜 목록 없이는 안 돌리나
 *
 * 목록이 없으면 k 를 셀 근거가 없다. 예전에는 최소 1명을 깔아 **k=3** 으로
 * 돌렸는데, 그러면 모든 군집이 이름 자리를 받아 `other` 가 없고 2초짜리
 * 부스러기에도 "화자 3" 이 붙었다. 셋 넘게 말한 회의는 매번 k < L+2 라,
 * 사용자 녹음(3명)에서 셋째 사람의 낱말 197개가 전부 둘째 사람에게 간 그 일이
 * 올리기마다 되풀이된다. 그러면서 올리기마다 0.27×길이만큼 줄을 붙든다.
 *
 * 틀린 화자 표시를 몇 분 들여 만드는 것보다, 안 나누고 "적으면 나눈다" 고
 * 말하는 편이 낫다. 전사문은 어느 쪽이든 그대로다.
 */
export const ROSTER_MISSING =
  "화자 목록을 적으면 소리로 화자를 나눕니다. 목록이 없어 이번에는 나누지 않았습니다 — " +
  "전사문은 그대로 있습니다.";

// ─────────────────────────────────────────────────────────────
//   에이전트에게 알릴 것
// ─────────────────────────────────────────────────────────────

/** 저쪽 `MAX_BRIEF_NOTE`. 넘으면 **말없이 잘린다** (`asr-models.ts` 와 같은 값). */
const BRIEF_NOTE_CHARS = 200;

/**
 * 에이전트에게 넘기는 **분리 서술.**
 *
 * `asr-models.ts` 의 `modelBrief` 와 같은 규율이다 — 글이 아니라 표로 보내고,
 * **여기 실리는 것은 서술자에 코드로 적힌 글이어야 한다.** 사람이 친 이름이나
 * 파일 이름이 이 길로 오면 그것이 곧 안내문이 된다. 사람이 준 것은 `context`
 * 로 간다.
 *
 * **이름을 정하는 것은 에이전트다.** 음향이 말한 시간 순서만으로 이름을
 * 맞히면 64.9% 인데(신탁 70.6%) 개별 파일에서는 20%까지 무너진다. 그래서
 * 순서는 **힌트로만** 준다 — 1등 무리가 목록의 1등 화자인 것이 9편 중 8편이다.
 *
 * **첫 등장 순서는 주지 마라.** 27.8~36.1% 로 찍기와 다르지 않다. 그런데
 * 그럴듯해 보여서 에이전트가 그것을 근거로 삼는다.
 */
export interface AgentDiarBrief {
  id: string;
  name: string;
  /** 무리 수. 목록 인원보다 이만큼 많다 — 남는 무리는 사람이 아니라 소리다. */
  clusterCount: number;
  /** 사람이 적어 준 이름. 이 중에서 고른다. */
  roster: string[];
  /** 목록에 없는 사람에게 붙일 이름. */
  otherLabel: string;
  /** 무리를 말한 시간 순으로 준다. 첫 등장 순서는 **주지 않는다.** */
  clustersOrderedBy: "talk-time";
  notes: string[];
}

export function diarBrief(m: DiarModel, roster: string[]): AgentDiarBrief {
  return {
    id: m.id,
    name: m.name,
    clusterCount: clusterCountFor(m, roster.length),
    roster: [...roster],
    otherLabel: OTHER_SPEAKER,
    clustersOrderedBy: "talk-time",
    /*
     * 넘치는 쪽지는 **자르지 않고 뺀다.** 200자에서 잘린 경고는 문장이 반만
     * 남아 뜻이 뒤집힐 수 있고, 잘렸다는 사실은 아무 데도 안 뜬다.
     */
    notes: m.agentNotes.filter((n) => n.length <= BRIEF_NOTE_CHARS),
  };
}

/**
 * 대화·요약에 실어 보내는 **짧은 판.**
 *
 * `agentReadingCaveat` 과 짝이다. 여기서 필요한 것은 "화자 이름을 얼마나
 * 믿을 것인가" 하나다.
 */
export function diarReadingCaveat(m: DiarModel, warnLowConfidence: boolean): string {
  const parts = [
    "화자는 소리로 갈랐다. 목소리가 비슷하거나 여럿이 겹쳐 말한 자리에서는 " +
      `이름이 바뀌어 붙어 있을 수 있고, 목록에 없던 사람은 '${OTHER_SPEAKER}' 로 묶여 있다.`,
  ];
  if (warnLowConfidence) {
    parts.push(
      "이 녹음은 목소리가 잘 갈리지 않았다. 누가 말했는지를 근거로 삼는 말은 " +
        "특히 조심해서 하고, 확실하지 않으면 그렇다고 말해라.",
    );
  }
  parts.push("이름이 누구인지 헷갈리면 대사의 내용을 믿어라. 소리는 번호까지만 말해 준다.");
  return parts.join(" ");
}

/**
 * 화면과 README 에 적는 출처. **의무다.**
 *
 * 분할 모델이 MIT 이고 MIT 는 저작권 표시를 함께 실을 것을 요구한다
 * (`Copyright (c) 2022 CNRS`). 그래서 `credit.copyright` 가 있으면 붙인다.
 */
export function diarAttribution(m: DiarModel): string {
  return m.attribution;
}

/** 이 모델을 쓰려면 폴더에 있어야 하는 파일 이름들. 내려받기와 확인이 같은 목록을 본다. */
export function diarFileNames(m: DiarModel): string[] {
  return [m.segmentation.name, m.embedding.name];
}

/** 늘어나는 디스크 (바이트). CAM++ 기준 34,274,077B = 34.3MB. */
export function diarDiskBytes(m: DiarModel): number {
  return m.segmentation.size + m.embedding.size;
}
