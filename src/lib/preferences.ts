/**
 * 클라이언트 사이드 표시 prefs — localStorage 에 보관.
 * (메모함별 리스트/그리드 보기는 서버 DB 에 저장되므로 여기 없음)
 */

export const THEMES = [
  { key: "forest", label: "Forest", swatch: "oklch(0.78 0.14 145)" },
  { key: "ocean", label: "Ocean", swatch: "oklch(0.78 0.14 220)" },
  { key: "sunset", label: "Sunset", swatch: "oklch(0.79 0.16 55)" },
  { key: "lavender", label: "Lavender", swatch: "oklch(0.80 0.13 295)" },
  { key: "mono", label: "Mono", swatch: "oklch(0.88 0.008 250)" },
  { key: "rose", label: "Rose", swatch: "oklch(0.79 0.15 15)" },
] as const;

export type ThemeKey = (typeof THEMES)[number]["key"];
export const DEFAULT_THEME: ThemeKey = "forest";

export const MODES = ["dark", "light"] as const;
export type ModePref = (typeof MODES)[number];
export const DEFAULT_MODE: ModePref = "light";

/**
 * 메모함 그리드 열 개수. 위젯 윙이 없어 가로를 전부 쓸 수 있으므로 6단까지 연다.
 */
export const COLUMNS = ["auto", "1", "2", "3", "4", "5", "6"] as const;
export type ColumnsPref = (typeof COLUMNS)[number];
export const DEFAULT_COLUMNS: ColumnsPref = "auto";

/**
 * 메모를 지울 때 확인창을 얼마나 자주 띄울지.
 * 삭제해도 30일 휴지통에 남기 때문에 "묻지 않음" 도 안전한 선택이다.
 */
export const DELETE_CONFIRM = ["always", "daily", "never"] as const;
export type DeleteConfirmPref = (typeof DELETE_CONFIRM)[number];
export const DEFAULT_DELETE_CONFIRM: DeleteConfirmPref = "daily";

export const DELETE_CONFIRM_LABEL: Record<DeleteConfirmPref, string> = {
  always: "매번",
  daily: "하루 한 번",
  never: "묻지 않음",
};

/*
 * localStorage 키는 **앱 이름으로 갈라 둔다.**
 *
 * 포트가 다르면 오리진이 달라 어차피 안 섞이지만, `BASE_PATH` 로 한 도메인에
 * `/voice` 와 `/memo` 를 나란히 얹으면 **오리진이 같아진다.** localStorage 는
 * 경로를 구분하지 않으므로 그때는 두 앱이 같은 칸을 쓰게 되고, 한쪽에서 테마나
 * 열 개수를 바꾸면 다른 쪽이 따라 바뀐다.
 *
 * `layout.tsx` 의 테마 확정 스크립트가 이 상수를 빌드 때 박아 넣으므로
 * 여기만 고치면 된다.
 */
export const STORAGE_KEYS = {
  theme: "voicebento.theme",
  mode: "voicebento.mode",
  columns: "voicebento.columns",
  deleteConfirm: "voicebento.deleteConfirm",
  /** 마지막으로 확인창을 띄운 날 (YYYY-MM-DD). */
  deleteConfirmedOn: "voicebento.deleteConfirmedOn",
} as const;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function readDeleteConfirmPref(): DeleteConfirmPref {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.deleteConfirm);
    if (v && (DELETE_CONFIRM as readonly string[]).includes(v)) {
      return v as DeleteConfirmPref;
    }
  } catch {
    /* */
  }
  return DEFAULT_DELETE_CONFIRM;
}

/**
 * 메모 삭제 확인. 설정에 따라 물어보거나 그냥 통과시킨다.
 * "하루 한 번" 이면 그날 처음 지울 때만 묻는다.
 */
export function confirmMemoDelete(message: string): boolean {
  const pref = readDeleteConfirmPref();
  if (pref === "never") return true;
  if (pref === "daily") {
    try {
      if (localStorage.getItem(STORAGE_KEYS.deleteConfirmedOn) === today()) {
        return true; // 오늘은 이미 물어봤다
      }
    } catch {
      /* */
    }
  }
  const ok = confirm(message);
  if (ok && pref === "daily") {
    try {
      localStorage.setItem(STORAGE_KEYS.deleteConfirmedOn, today());
    } catch {
      /* */
    }
  }
  return ok;
}

/**
 * 5·6단은 xl(1280px)에서 바로 펼치면 카드 폭이 250px 아래로 떨어져 헤더가 뭉갠다.
 * 그래서 xl 까지는 3단으로 두고 2xl(1536px) 이상에서만 선택한 단수로 펼친다.
 */
export const COLUMN_CLASS: Record<ColumnsPref, string> = {
  // auto 는 화면이 넓어질수록 열을 늘린다 (컨테이너 상한 2560px 까지)
  auto: "grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-[2200px]:grid-cols-5",
  "1": "grid-cols-1",
  "2": "grid-cols-1 md:grid-cols-2",
  "3": "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
  "4": "grid-cols-1 md:grid-cols-2 xl:grid-cols-4",
  "5": "grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5",
  "6": "grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6",
};

export function applyThemeAndModeToHtml(theme: ThemeKey, mode: ModePref) {
  const root = document.documentElement;
  Array.from(root.classList)
    .filter((c) => c.startsWith("theme-") || c.startsWith("mode-"))
    .forEach((c) => root.classList.remove(c));
  root.classList.add(`theme-${theme}`, `mode-${mode}`);
}
