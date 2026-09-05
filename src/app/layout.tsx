import type { Metadata } from "next";

import { assetPath } from "@/lib/api-path";
import { DEFAULT_MODE, DEFAULT_THEME, STORAGE_KEYS } from "@/lib/preferences";

import "./globals.css";

/**
 * 뿌리 레이아웃.
 *
 * MailBento·MemoBento·PaperBento 와 **같은 껍데기**여야 한다. 앱들을 나란히
 * 띄워 두고 쓰는 사람에게 글꼴이나 배경이 미묘하게 다른 것은 그냥 버그로
 * 보인다. 그래서 globals.css 의 변수는 형제 앱 것을 그대로 가져왔고, 이
 * 파일도 테마 확정 스크립트까지 같은 모양으로 둔다.
 */

export const metadata: Metadata = {
  title: "VoiceBento",
  description: "소리와 영상을 전사문으로 바꿔 두고 읽는 자리",
  /*
   * 이름이 `favicon.svg` 인 것은 우연이 아니다. 미들웨어의 공개 목록이
   * "/favicon" 으로 시작하는 경로를 통과시킨다 — 다른 이름으로 두면 인증을
   * 켠 배포에서 로그인 화면의 탭 아이콘이 로그인 페이지 HTML 을 받아 깨진다.
   */
  icons: { icon: assetPath("/favicon.svg") },
};

/*
 * 테마 키는 preferences.ts 에서 가져와 문자열에 박는다.
 *
 * 이 스크립트는 번들이 아니라 인라인 문자열이라 import 가 통하지 않는다.
 * 그렇다고 키를 손으로 적어 두면 preferences.ts 를 고친 날 여기만 옛 키를
 * 읽어 첫 페인트가 기본 테마로 돌아간다 — 새로고침할 때마다 한 번 깜빡이는데
 * 원인을 찾기가 고약하다. 빌드 때 갈아 끼워 두 곳이 갈라질 길을 없앤다.
 */
const THEME_BOOT = `(function(){try{
var t=localStorage.getItem(${JSON.stringify(STORAGE_KEYS.theme)})||${JSON.stringify(DEFAULT_THEME)};
var m=localStorage.getItem(${JSON.stringify(STORAGE_KEYS.mode)});
if(m!=='dark'&&m!=='light')m=${JSON.stringify(DEFAULT_MODE)};
document.documentElement.className='theme-'+t+' mode-'+m;
}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="ko"
      // 서버가 보내는 기본값. CSS 는 다크가 밑바탕이라 클래스가 없는 순간은
      // 그대로 다크로 보인다 — 아래 스크립트가 localStorage 로 고쳐 쓰기 전까지의
      // 그 짧은 틈을 없애려고 라이트를 미리 박아 둔다.
      className={`theme-${DEFAULT_THEME} mode-${DEFAULT_MODE}`}
      suppressHydrationWarning
    >
      <head>
        {/* 첫 페인트 전에 테마를 확정한다. <body> 에 두면 그 전에 한 번
            다크로 칠해진 화면이 보인다. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@latest/dist/web/variable/pretendardvariable.css"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Nanum+Myeongjo:wght@400;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body className="relative z-10">{children}</body>
    </html>
  );
}
