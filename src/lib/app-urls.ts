import type { AppUrls } from "@/components/cross-app-link";

import { env } from "./env";

/**
 * 머리글의 앱 전환 메뉴(`AppSwitcher`)에 넘길 형제 앱 주소.
 *
 * 비어 있는 칸은 화면이 접속한 호스트에서 유추한다. 한 도메인을 경로로 나눠
 * 쓰는 배포(`…/mail`·`/memo`·…)에서는 유추가 못 맞히므로 전부 채워야 한다 —
 * 하나라도 빠지면 메뉴의 그 칸만 엉뚱한 포트로 간다.
 *
 * 다섯 앱에 같은 모양의 파일이 있다. 자기 자신만 빠진다.
 */
export function appUrls(): AppUrls {
  return {
    mailbento: env.MAILBENTO_URL?.trim() || null,
    memobento: env.MEMOBENTO_URL?.trim() || null,
    paperbento: env.PAPERBENTO_URL?.trim() || null,
    ledgerbento: env.LEDGERBENTO_URL?.trim() || null,
  };
}
