/*
 * SQLite 연결 한 개와 그 위의 drizzle 한 개.
 *
 * 앱 어디서든 `import { db } from "@/lib/db"` 로만 닿는다. 연결을 여기저기서
 * 열면 WAL 설정과 마이그레이션이 여러 번 돌고, 그중 하나만 pragma 를 빼먹는
 * 날이 온다.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { env } from "../env";
import * as schema from "./schema";

type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/**
 * 지연 초기화 — DB 연결/마이그레이션은 첫 쿼리(런타임) 때 1회만 수행한다.
 * `next build` 의 page-data 수집 단계에서 모듈이 import 되어도 DB 파일을 열지
 * 않으므로, 병렬 빌드 워커가 WAL 설정(쓰기)으로 충돌해 "database is locked" 가
 * 나던 문제를 막는다.
 */
let _db: DB | null = null;

function init(): DB {
  const dbPath = resolve(env.DATABASE_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  /*
   * 기다렸다 실패한다.
   *
   * 이 앱에는 쓰는 쪽이 둘이다 — 사람의 요청과, 전사 워커의 진행을 받아 적는
   * 부모 쪽 코드. 조각 하나가 끝날 때마다 INSERT 가 도는데, 그 순간 사람이
   * 목록을 열면 부딪힌다. `busy_timeout` 이 없으면 그 자리에서 즉시
   * "database is locked" 다.
   */
  sqlite.pragma("busy_timeout = 5000");
  /*
   * 외래키 강제. **끄면 안 된다.**
   *
   * SQLite 는 이 pragma 가 연결마다 꺼진 채로 시작한다. 녹음을 지우면 조각과
   * 요약이 딸려 지워지는 것이 여기에 걸려 있다 — 끄면 녹음만 사라지고 조각
   * 수천 줄이 고아로 남는다.
   */
  sqlite.pragma("foreign_keys = ON");

  const drizzleDb = drizzle(sqlite, { schema });

  try {
    const migrationsFolder =
      process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), "drizzle");
    migrate(drizzleDb, { migrationsFolder });
  } catch (err) {
    console.error("[voicebento] migration failed:", err);
  }

  return drizzleDb as DB;
}

function getDb(): DB {
  // Node 는 단일 스레드 + init() 은 동기이므로 경쟁 조건 없음.
  if (!_db) _db = init();
  return _db;
}

/** import 시점엔 연결하지 않고, 실제 사용(프로퍼티 접근) 때 초기화하는 프록시. */
export const db = new Proxy({} as DB, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
}) as DB;

export { schema };
