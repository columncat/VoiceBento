import type { ModelNoticeDTO } from "@/lib/types";

/**
 * 서버가 실어 준 **모델 서술자**를 화면이 쓰는 모양으로 바꾼다.
 *
 * ## 왜 화면 쪽에 이 파일이 있나
 *
 * 서술자의 정본은 서버에 있다 — `scripts/asr-models.json` 에 사실이 적히고
 * `lib/asr-models.ts` 가 불변식을 걸고 `lib/model.ts` 가 화면에 나갈 모양
 * (`ModelNoticeDTO`)으로 옮긴다. 여기 있는 것은 그것을 **읽는 법**뿐이다.
 *
 * 읽는 법이 따로 필요한 까닭은 두 가지다.
 *
 * 1. 서술자에 새로 생긴 칸이 **전부 선택 사항**이다. 서버가 아직 안 실어
 *    주거나 목록 요청이 실패했을 때도 화면이 돌아야 한다 — 안내가 화면에서
 *    사라지는 것이 가장 나쁜 결과다.
 * 2. 화면만의 물음이 있다. "낱말을 눌러도 되나" 는 서버가 안 하는 질문이다.
 *
 * `format.ts` 와 `upload-queue.ts` 가 같은 이유로 `src/lib` 이 아니라 여기
 * 사는 것과 같은 결이다.
 *
 * ## "한국어를 못 한다" 를 문장이 아니라 **코드로** 판단한다
 *
 * 전에는 화면에 그 문장이 박혀 있었다. 한국어 되는 모델을 붙이는 날 그 자리가
 * 옛말로 남는다. 지금은 `languageCodes` 에 `ko` 가 있는지만 본다 — 모델을
 * 갈아 끼우면 안내가 **저절로** 바뀐다. 그것이 "서술자에서 읽는다" 의 뜻이다.
 *
 * (서버도 `koreanUnsupported` 를 같은 방법으로 만든다. 그 값이 오면 그걸
 * 믿고, 코드 목록이 함께 오면 코드를 본다 — 코드가 더 일반적인 물음에
 * 답하기 때문이다. 언젠가 이 화면이 다른 말로 쓰일 수도 있다.)
 */

/** 이 화면이 쓰는 말. 모델이 이 말을 알아듣는지로 경고를 가른다. */
export const UI_LANGUAGE = "ko";

/**
 * 걸릴 시간을 어림하는 배수.
 *
 * uno 실측 RTF 0.096 을 올려 잡은 값이다. 이제 서버가 `ModelNoticeDTO.rtf` 로
 * 실어 보내므로 **이 값은 못 받았을 때만 쓴다** — 서버가 없거나, 그 칸을
 * 모르는 옛 서버이거나, 서술자에 재 본 값이 없는 모델일 때.
 */
export const DEFAULT_RTF = 0.1;

export interface ModelCapability {
  name: string;
  /** ISO 639-1 코드. 못 받으면 빈 배열 — 그때는 `languageSummary` 만 쓴다. */
  languages: string[];
  /** 짧은 목록. 문장 안에 넣는 자리에 쓴다. */
  languageSummary: string;
  /** 긴 목록. 펼쳐 보는 자리에 쓴다. 없으면 짧은 것을 쓴다. */
  languageLong: string;
  /** 이 화면의 말을 알아듣나. 아니면 경고를 띄운다. */
  understandsUiLanguage: boolean;
  /** 시각의 잘기. 못 받으면 낱말이 오는 것을 보고 판단할 수 없으므로 `token` 으로 본다. */
  timestamps: "none" | "token" | "word";
  /** 시각 눈금(초). 모르면 null. */
  granularitySec: number | null;
  /**
   * 낱말을 눌러 그 시각으로 갈 수 있나.
   *
   * `timestamps: "none"` 인 모델(sherpa-onnx 의 whisper 갈래가 실제로 그렇다 —
   * `timestamps: []` 를 준다)에서는 **낱말 클릭을 접고 줄 클릭만 남긴다.**
   * 시각이 없는데 낱말마다 손가락 모양이 뜨면, 눌러 보고 아무 데도 안 가는
   * 것을 겪은 뒤에야 안 된다는 것을 안다.
   *
   * 서술자에 이 칸이 없으면 켜 둔다. 옛 서버가 주는 것은 지금 물려 있는
   * parakeet 이고 그것은 시각을 준다 — 되는 것을 안 된다고 접는 쪽이
   * 안 되는 것을 켜 두는 쪽보다 손해가 크다(줄 클릭은 어차피 늘 된다).
   */
  wordClick: boolean;
  /** VAD 조각의 최대 길이(초). 줄 하나가 이보다 길 수 없다. 모르면 null. */
  segmentMaxSec: number | null;
  /** 실시간 대비 배수. 걸릴 시간 어림에 쓴다. */
  /**
   * 실시간 대비 배수. **재 본 적이 없는 모델이면 null 이다.**
   *
   * 못 받았을 때 parakeet 의 값(0.096)을 대신 쓰면, 아무도 재지 않은 모델에
   * 대고 "1시간 → 약 6분" 이라고 단언하게 된다. 모르면 말하지 않는 편이 낫다 —
   * 어림이 없어서 답답한 것보다 틀린 어림을 믿고 기다리는 쪽이 나쁘다.
   */
  rtf: number | null;
  attribution: string;
  /** 못 하는 것을 사람 말로 적은 한 문단. */
  notice: string;
  /** 서버가 준 것인가, 우리가 들고 있던 기본값인가. */
  fromServer: boolean;
}

/**
 * 서버에서 아무것도 못 받았을 때 쓰는 값.
 *
 * 지금 이 앱에 실제로 물려 있는 모델의 사실이다. **기본값이라는 것이 화면에
 * 보여야 한다**(`fromServer: false`) — 나중에 한국어 되는 모델로 갈아 끼운
 * 뒤 목록 요청이 실패하면, 이 값이 "한국어를 못 합니다" 라는 **거짓말**이
 * 되기 때문이다. 화면은 그때 "모델 정보를 못 받았습니다" 를 함께 적는다.
 */
const FALLBACK: ModelCapability = {
  name: "parakeet-tdt-0.6b-v3",
  // parakeet v3 가 알아듣는 유럽어 25개. 한국어(ko)가 없다.
  languages: [
    "en", "es", "fr", "de", "bg", "hr", "cs", "da", "nl", "et", "el", "fi", "hu",
    "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "sv", "ru", "uk",
  ],
  languageSummary: "영어를 비롯한 유럽 25개 언어",
  languageLong: "영어를 비롯한 유럽 25개 언어",
  understandsUiLanguage: false,
  timestamps: "token",
  granularitySec: 0.08,
  wordClick: true,
  segmentMaxSec: 30,
  rtf: DEFAULT_RTF,
  attribution: "전사 모델: NVIDIA parakeet-tdt-0.6b-v3 (CC BY 4.0) · sherpa-onnx (Apache-2.0)",
  notice:
    "한국어는 알아듣지 못합니다. 한국어 오디오를 넣으면 오류 대신 빈 글이나 엉뚱한 로마자가 나옵니다.",
  fromServer: false,
};

/**
 * 서버가 준 것을 화면이 쓰는 모양으로.
 *
 * 없으면 기본값. **어느 쪽인지 `fromServer` 로 남긴다.**
 */
export function readModel(m: ModelNoticeDTO | null | undefined): ModelCapability {
  if (!m) return FALLBACK;

  const codes = (m.languageCodes ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  const kind = m.timestamps ?? FALLBACK.timestamps;

  return {
    name: m.name || FALLBACK.name,
    languages: codes,
    languageSummary: m.languages || FALLBACK.languageSummary,
    languageLong: m.languagesLong || m.languages || FALLBACK.languageLong,
    /*
     * 코드 목록이 오면 그것으로 판단하고, 없으면 서버가 만든 참거짓을 믿는다.
     * 코드가 먼저인 것은 그쪽이 더 일반적인 물음(이 화면의 말을 아나)에
     * 답하기 때문이다 — `koreanUnsupported` 는 한국어에만 답한다.
     */
    understandsUiLanguage: codes.length > 0 ? codes.includes(UI_LANGUAGE) : !m.koreanUnsupported,
    timestamps: kind,
    granularitySec: m.timestampResolution ?? null,
    wordClick: kind !== "none",
    segmentMaxSec: m.segmentMaxSeconds ?? null,
    /*
     * 서버가 준 값이 이긴다. 0 이나 음수는 시간 어림을 0 으로 만드니 안 받는다
     * ("곧 끝납니다" 라고 적어 놓고 몇 분을 기다리게 하는 쪽이 더 나쁘다).
     */
    /*
     * 서버가 준 값만 쓴다. 없으면 **null** — 서술자에 재 본 값이 없는 모델이라는
     * 뜻이고, 그때 parakeet 의 값을 끌어다 쓰면 화면이 재지도 않은 숫자를
     * 단언한다. 0 이나 음수도 안 받는다("곧 끝납니다" 라고 적고 몇 분을
     * 기다리게 하는 쪽이 더 나쁘다).
     */
    rtf: typeof m.rtf === "number" && m.rtf > 0 ? m.rtf : null,
    attribution: m.attribution?.trim() || FALLBACK.attribution,
    notice: m.notice?.trim() || FALLBACK.notice,
    fromServer: true,
  };
}

/**
 * 코드를 사람이 읽는 이름으로.
 *
 * `Intl.DisplayNames` 를 쓴다 — 표를 손으로 들고 있으면 모델을 갈아 끼울 때
 * 그 표에 없는 코드가 반드시 나온다. 못 옮기면 코드를 그대로 돌려준다.
 *
 * **브라우저에서만 부른다.** `Intl` 의 언어 자료는 Node 와 브라우저에서
 * 판본이 다를 수 있어, 서버가 그린 글자와 브라우저가 그린 글자가 어긋나면
 * 하이드레이션이 깨진다. 그래서 이 함수를 쓰는 자리는 **펼쳐 봐야 그려지는
 * 목록** 하나뿐이다.
 */
export function languageNames(codes: string[]): string[] {
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames([UI_LANGUAGE], { type: "language" });
  } catch {
    /* 이 판에 없으면 코드를 그대로 쓴다 */
  }
  return codes.map((c) => {
    try {
      return dn?.of(c) ?? c;
    } catch {
      return c;
    }
  });
}
