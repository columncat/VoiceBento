import type { AsrModel } from "./asr-models";
import { asrModel } from "./env";
import type { ModelNoticeDTO } from "./types";

/**
 * 화면에 나가는 모델 안내. **여기서 짓지 않고 서술자에서 만든다.**
 *
 * ## 무엇이 바뀌었나
 *
 * 예전에는 이 파일에 "한국어를 못 합니다" 가 문장으로 박혀 있었다. 그러면
 * 모델을 갈아 끼우는 날 여기만 옛말이 남는다 — 한국어를 알아듣는 모델을
 * 붙여 놓고도 화면에는 계속 "한국어를 못 합니다" 가 뜨고, 그건 틀린 것을
 * 넘어 사람이 쓸 수 있는 기능을 못 쓰게 만든다.
 *
 * 지금은 사실이 `scripts/asr-models.json` 에 있고 이 파일은 **그 사실로
 * 문장을 만든다.** `koreanUnsupported` 도 손으로 적지 않는다 — 지원 언어
 * 목록에 `ko` 가 있는지 보는 것이 전부다.
 *
 * ## 이 말이 왜 필요한가 (모델이 바뀌어도 변하지 않는 이유)
 *
 * 못 알아듣는 말을 넣어도 **오류가 나지 않는다.** 빈 글이나 엉뚱한 로마자가
 * 나올 뿐이라, 말해 주지 않으면 사람은 파일이 잘못된 줄 알고 같은 것을 몇
 * 번씩 다시 올린다. 그래서 목록 응답에 늘 함께 실려 나간다
 * (`GET /api/recordings` 의 `model`).
 *
 * ## 라이선스 — 화면에도 필요하다
 *
 * parakeet 가중치는 CC-BY-4.0 이라 출처를 밝힐 의무가 따라온다. README 에만
 * 적고 화면에서 빼면 쓰는 사람은 영영 못 본다. `attribution` 이 그 문장이고,
 * 이것도 서술자에서 온다 — 모델이 바뀌면 라이선스도 바뀐다.
 */

/**
 * 목적격 조사를 고른다.
 *
 * 문장을 **만들기** 때문에 필요하다. 손으로 적던 시절에는 라벨과 조사가 한
 * 덩어리라 틀릴 일이 없었는데, 라벨이 서술자에서 오면서 "여러 언어을" 처럼
 * 어긋난다. 모델을 갈아 끼울 때마다 사람이 고쳐 줄 수 있는 자리가 아니다.
 *
 * 한글 음절이면 종성 유무로 가른다 (유니코드 음절 = 초성×588 + 중성×28 + 종성).
 * 한글이 아닌 글자로 끝나면 "를" 로 둔다 — 이 자리에 오는 라벨은 서술자의
 * `languagesLabel` 이고 대개 "…언어" 로 끝난다.
 */
function objectParticle(word: string): "을" | "를" {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "를" : "을";
  return "를";
}

/** 이 앱이 알아듣는가. 지원 언어 목록만 보고 정한다. */
function speaks(m: AsrModel, code: string): boolean {
  return m.languages.includes(code);
}

/**
 * 알아듣지 못하는 말을 넣었을 때 무슨 일이 일어나는지.
 *
 * 문장을 둘로 나눠 만든다 — "무엇을 못 하는가" 와 "그래서 어떻게 보이는가".
 * 뒤엣것이 실제로 사람을 구하는 문장이다. 오류가 났다면 알아서 알아채겠지만,
 * **아무 일도 없었던 것처럼 빈 글이 나오면** 원인을 짚을 길이 없다.
 */
function buildNotice(m: AsrModel): string {
  if (speaks(m, "ko")) {
    return (
      `이 앱의 전사 모델은 ${m.languagesLabel}${objectParticle(m.languagesLabel)} 알아듣습니다. ` +
      `목록에 없는 말을 넣으면 오류 대신 빈 글이나 엉뚱한 글이 나옵니다.`
    );
  }
  return (
    "이 앱의 전사 모델은 **한국어를 알아듣지 못합니다.** 모델 어휘에 한글이 " +
    "하나도 없어서, 한국어 소리를 넣으면 오류가 나는 대신 빈 글이나 엉뚱한 " +
    `로마자가 나옵니다. ${m.languagesLabel} 녹음에 쓰세요.`
  );
}

export function toModelNotice(m: AsrModel): ModelNoticeDTO {
  return {
    name: m.name,
    languages: m.languagesLabel,
    koreanUnsupported: !speaks(m, "ko"),
    notice: buildNotice(m),

    // ── 여기부터는 계약에 없던 칸이다. 전부 선택 사항이라 옛 화면도 그대로 돈다. ──
    id: m.id,
    languagesLong: m.languagesLong,
    languageCodes: m.languages,
    /**
     * **낱말 클릭을 켤 수 있는가.**
     *
     * 이 칸이 없으면 화면은 "낱말 시각이 비어 있다" 와 "이 모델은 원래 안
     * 준다" 를 가르지 못한다. 못 가르면 시각을 안 주는 모델을 붙인 날
     * 낱말 클릭이 조용히 아무 데도 안 뛰는 버튼이 된다.
     */
    timestamps: m.runtime.timestamps,
    timestampResolution: m.timestampResolution,
    /** 한 조각의 최대 길이(초). 화면이 "왜 여기서 잘렸나" 를 설명할 재료. */
    segmentMaxSeconds: m.runtime.vad.maxSpeechDuration,
    /**
     * 실시간 대비 배수. **화면이 "1시간이면 약 몇 분" 을 적는 근거다.**
     *
     * 이 칸이 없던 동안 화면은 parakeet 실측값을 제 손으로 들고 있었다
     * (`model-capability.ts` 의 `DEFAULT_RTF`). 모델을 갈아 끼우면 그 값이
     * 곧 옛말이 된다 — 서술자에 있는 사실을 화면이 못 받아 베껴 든 꼴이라,
     * 여기로 내보낸다. 모르는 모델이면 null 이고 화면이 기본값으로 떨어진다.
     */
    rtf: m.rtf,
    attribution: m.attribution,
    credit: m.credit,
  };
}

/** 지금 쓰는 모델의 안내. 목록 응답에 그대로 실린다. */
export const MODEL_NOTICE: ModelNoticeDTO = toModelNotice(asrModel);
