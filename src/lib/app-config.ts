import { eq } from "drizzle-orm";

import { db, schema } from "./db";
import { DEFAULT_SUMMARY_PROMPT } from "./types";

/**
 * 한 줄짜리 설정.
 *
 * 칸으로 판 것은 `autoPolish` 하나뿐이고 나머지는 `settings` JSON 자루에
 * 들어간다. 자루로 둔 이유는 **넓히는 데 마이그레이션 번호가 필요 없어서**다.
 * 대신 규율이 하나 붙는다 — 읽는 쪽은 늘 **깨져 있을 것을 전제로** 읽는다.
 * 설정 한 줄 때문에 앱 전체가 멎는 것이 가장 나쁘다.
 */

export interface Settings {
  /** 요약을 만들 때 기본으로 실려 가는 지시문. */
  summaryPrompt: string;
}

export interface AppConfig extends Settings {
  /** 전사가 끝나면 곧바로 다듬기까지 갈지. */
  autoPolish: boolean;
}

function parseSettings(blob: string | null): Settings {
  const fallback: Settings = { summaryPrompt: DEFAULT_SUMMARY_PROMPT };
  if (!blob) return fallback;
  try {
    const parsed: unknown = JSON.parse(blob);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const prompt = (parsed as { summaryPrompt?: unknown }).summaryPrompt;
    return {
      summaryPrompt:
        typeof prompt === "string" && prompt.trim() ? prompt.slice(0, 4000) : fallback.summaryPrompt,
    };
  } catch {
    return fallback;
  }
}

export function readConfig(): AppConfig {
  const row = db.select().from(schema.appConfig).where(eq(schema.appConfig.id, 1)).get();
  return {
    // 행이 아직 없으면 기본값이다 — 켬.
    autoPolish: row ? row.autoPolish === 1 : true,
    ...parseSettings(row?.settings ?? null),
  };
}

export function writeConfig(patch: Partial<AppConfig>): AppConfig {
  const current = readConfig();
  const next: AppConfig = { ...current, ...patch };
  db.insert(schema.appConfig)
    .values({
      id: 1,
      autoPolish: next.autoPolish ? 1 : 0,
      settings: JSON.stringify({ summaryPrompt: next.summaryPrompt }),
    })
    .onConflictDoUpdate({
      target: schema.appConfig.id,
      set: {
        autoPolish: next.autoPolish ? 1 : 0,
        settings: JSON.stringify({ summaryPrompt: next.summaryPrompt }),
        updatedAt: new Date(),
      },
    })
    .run();
  return next;
}
