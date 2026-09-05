import type { ModelNoticeDTO } from "./types";

/**
 * 이 앱이 쓰는 전사 모델. **여기 적힌 것은 화면에 그대로 나가는 말이다.**
 *
 * ## 왜 이 안내가 코드 안에 있나
 *
 * 사람이 고른 모델은 `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` 이고,
 * 이 모델은 **한국어를 전혀 못 한다** — 어휘 8,193개에 한글이 하나도 없다.
 * 그 사실을 알고 고른 것이다("parakeet 그대로, 한국어는 포기"). 그러니 다른
 * 모델을 몰래 끼워 넣지 마라.
 *
 * 대신 **사람이 그 사실을 알 수 있어야 한다.** 한국어를 넣어도 오류가 나지
 * 않는다. 빈 글이나 엉뚱한 로마자가 나올 뿐이라, 말해 주지 않으면 사람은
 * 파일이 잘못된 줄 알고 같은 것을 몇 번씩 다시 올린다. 그래서 이 문장이
 * 목록 응답에 늘 함께 실려 나간다 (`GET /api/recordings` 의 `model`).
 *
 * ## 라이선스 — 이것도 화면에 필요하다
 *
 * 원본 가중치 `nvidia/parakeet-tdt-0.6b-v3` 는 **CC-BY-4.0** 이다. 출처를
 * 밝힐 의무가 따라온다. README 에 적어 두었지만, 화면 어딘가(설정·정보)에도
 * 한 줄 있으면 좋다 — `attribution` 이 그 문장이다.
 */
export const MODEL_NOTICE: ModelNoticeDTO & { attribution: string } = {
  name: "parakeet-tdt-0.6b-v3 (int8)",
  languages: "영어를 비롯한 유럽 25개 언어",
  koreanUnsupported: true,
  notice:
    "이 앱의 전사 모델은 **한국어를 알아듣지 못합니다.** 모델 어휘에 한글이 " +
    "하나도 없어서, 한국어 소리를 넣으면 오류가 나는 대신 빈 글이나 엉뚱한 " +
    "로마자가 나옵니다. 영어를 비롯한 유럽 언어 녹음에 쓰세요.",
  attribution:
    "전사 모델: NVIDIA parakeet-tdt-0.6b-v3 (CC-BY-4.0), " +
    "sherpa-onnx 로 내보낸 int8 판본 (Apache-2.0).",
};
