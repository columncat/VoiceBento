"use client";

import { AlertTriangle, Check, Loader2, Mic, UserRoundSearch, Users, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/client-api";
import { nameKey } from "@/lib/name-key";
import { HttpError } from "@/lib/read-json";
import type {
  DiarNoticeDTO,
  DiarizationDTO,
  JobState,
  SegmentDTO,
  SpeakerState,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import { estimateWork, formatLength } from "./format";
import { RosterInput } from "./roster-input";
import type { ClusterNamer, SpeakerStyle } from "./speaker";

/**
 * **화자 나누기** — 목록을 받고, 소리로 가르고, 목소리마다 이름을 붙이는 자리.
 *
 * ## 왜 목록을 받나 — 안 받으면 40~134명이 나온다
 *
 * 사람 수를 안 주고 문턱으로 무리를 정하면 진짜 회의에서 화자가 40~134명
 * 나왔다(실측). 그래서 목록은 **반드시** 받는다. 한 명도 안 적으면 단추가
 * 안 눌린다.
 *
 * ## "모르면 넉넉히 적으세요" — 비대칭이 분명하다
 *
 * 한 사람을 빠뜨리면 정확도가 8.3pt 떨어지고, 한 사람을 더 적으면 4.1pt
 * 오른다. 그러니 이 화면은 "정확히 몇 명인가요" 를 물으면 안 된다. 문구는
 * 서술자에서 온다 (`DiarNoticeDTO.rosterHint`) — 화면에 박아 두면 그 판단이
 * 두 곳에 살게 된다.
 *
 * ## `k = 인원 + 2` 는 **화면에 안 보인다**
 *
 * 무리 수는 사람에게 물어볼 값이 아니다. 실측으로 정해진 값이고
 * (`clusterMargin`), k=L 로 주면 사용자의 진짜 녹음에서 셋째 사람의 낱말
 * 197개가 197개 전부 둘째 사람에게 붙었다. 화면은 이름만 보내고 서버가 셈한다.
 *
 * ## 이름은 **목소리마다** 고친다
 *
 * 같은 사람의 줄이 200개면 줄마다 고치는 것은 200번이다. 이름은 군집 → 이름
 * 표 한 칸에만 살고(`diarizations.names`), 여기서 한 칸을 고치면 그 목소리의
 * 모든 줄이 함께 바뀐다.
 *
 * 줄 하나만 잘못 붙은 것은 다른 일이라 줄에서 고친다. 그렇게 고친 줄은
 * **다시 나눠도 안 덮인다** (`speakerSource = "human"`).
 *
 * 이름 표는 **사람이 손댄 칸만** 보낸다. 서버도 지금 값과 다른 이름만 사람의 것으로
 * 적는다 (`setDiarNames`). 한 칸만 고쳤는데 에이전트가 붙인 나머지까지 사람 것으로
 * 잠기면, 다음 다듬기가 잘못 짚은 이름을 고칠 수 없다. 표 전체를 초안으로 들고 있다가
 * 보내면, 그 사이 에이전트가 고친 칸까지 옛 값으로 되돌려 사람 것으로 잠근다.
 *
 * ## 다시 나누면 이름은 **목소리를 따라간다** — 초안도 따라가야 한다
 *
 * 군집 번호는 판마다 뜻이 바뀐다. 서버가 겹친 시간으로 이름을 옮기고, 어느
 * 목소리인지 뚜렷하지 않아 못 옮긴 사람 이름은 `recheckNames` 로 돌아온다.
 * 그 목록은 이름 칸 바로 위에 뜬다 — 사람이 그 이름을 칸에 붙이거나 × 로 빼고
 * 저장하면 그 이름만 빠진다.
 *
 * 이 패널은 분리가 도는 동안에도 열려 있고 폴링이 새 판을 가져온다. 그때 **옛 번호의
 * 초안을 들고 있으면 안 된다** — 예전에는 패널이 닫혀 있을 때만 초안을 맞춰서, 열린
 * 채로 다시 나누기가 끝나면 옛 번호의 이름이 새 판의 다른 목소리에 저장됐다. 그래서
 * 판(`run`)이 바뀌면 초안을 버리고, 적고 있던 글자는 "화자를 다시 나눴습니다" 와 함께
 * 보여 준다. 서버도 판이 다른 저장을 409 로 막는다 (폴링보다 먼저 저장을 누른 경우).
 */

/** 패널의 가장 넓은 폭 (px, 32rem). */
const PANEL_MAX_WIDTH = 512;
/** 패널과 창 가장자리 사이에 늘 남길 여백 (px). */
const PANEL_EDGE = 12;

export function SpeakerPanel({
  recordingId,
  state,
  speakerState,
  speakerError,
  duration,
  diarization,
  diar,
  roster,
  segments,
  namer,
  speakers,
  onStarted,
  onNamed,
  onRefresh,
  className,
}: {
  recordingId: string;
  state: JobState;
  speakerState: SpeakerState;
  speakerError: string | null;
  duration: number | null;
  diarization: DiarizationDTO | null;
  /** 화자 분리 기능의 고정 안내. 아직 못 받았으면 null — 그때는 단추를 안 켠다. */
  diar: DiarNoticeDTO | null;
  /** 지금 적혀 있는 화자 목록. */
  roster: string[];
  segments: SegmentDTO[];
  /**
   * 군집 번호 → 이름, 이름 → 색·선 모양. **본문과 같은 한 벌을 받는다.**
   *
   * 여기서 제 손으로 만들면 본문과 다른 색이 나온다 — 본문은 나온 순서로,
   * 여기는 말한 시간 순으로 번호를 매기게 되니 거의 늘 어긋난다. 색은 이
   * 화면에서 사람을 가르는 주된 표시라 그 어긋남이 곧바로 보인다.
   */
  namer: ClusterNamer;
  speakers: Map<string, SpeakerStyle>;
  /** 나누기가 시작됐다. 화면이 상태를 낙관적으로 옮긴다. */
  onStarted: () => void;
  /** 이름표가 바뀌었다. 바뀐 조각이 함께 온다. */
  onNamed: (diarization: DiarizationDTO | null, segments: SegmentDTO[]) => void;
  /**
   * 상세를 지금 다시 받아 달라. 이름 저장이 "판이 바뀌었다"(409)로 돌아왔을 때 부른다 —
   * 다음 폴링을 기다리면 그동안 사람은 옛 번호의 칸을 보고 있다.
   */
  onRefresh: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(roster);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 사람이 **손댄** 이름 칸만. 군집 번호 → 적고 있는 이름 (`""` 이면 지우기).
   *
   * 손대지 않은 칸은 늘 서버의 지금 값을 보여 준다. 표 전체를 초안으로 복사해 두면
   * 폴링으로 온 새 값(에이전트가 고친 이름, 다시 나눈 판)이 화면에 안 보이고, 저장할 때
   * 옛 값이 그대로 되돌아간다.
   */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** "다시 확인" 목록에서 사람이 × 로 뺀 이름. 저장할 때 함께 간다. */
  const [dismissed, setDismissed] = useState<string[]>([]);
  /**
   * 판이 바뀌어 **저장하지 못한 채 걷어 낸** 사람의 글. null 이면 알릴 것이 없다.
   * 조용히 버리지 않는다 — 사람은 적은 이름이 왜 사라졌는지 알아야 다시 적는다.
   */
  const [resplit, setResplit] = useState<{ typed: string[] } | null>(null);
  /** 지금 `edits` 가 **어느 판의 번호**로 적힌 것인가 (`DiarizationDTO.run`). */
  const editRun = useRef<string | null>(diarization?.run ?? null);
  const [savingNames, setSavingNames] = useState(false);

  /*
   * **패널이 화면 밖으로 안 나가게** 자리를 잰다.
   *
   * 단추는 도구줄 **왼쪽**에 있다(다듬기 왼쪽). 예전에는 패널을 단추의 오른쪽 끝에
   * 붙였는데(`right-0`), 그러면 패널이 단추에서 왼쪽으로 펼쳐져 창 너비 1023px 에서 왼쪽
   * 끝이 −368px 였다 — 이름 칸 절반이 안 보였다. 사람이 이름을 적는 바로 그 칸이다.
   *
   * CSS 한 줄(`left-0`)로 뒤집으면 이번에는 단추가 오른쪽으로 밀리는 좁은 화면(도구줄이
   * 줄바꿈되는 폭)에서 오른쪽으로 넘친다. 단추가 어디에 서든 맞게 **열 때 재서** 정한다:
   * 단추 왼쪽 끝에서 펼치되, 오른쪽이 넘치면 넘친 만큼 왼쪽으로 당기고, 왼쪽 여백 아래로는
   * 안 간다. 폭도 같은 자리에서 정한다 — CSS 의 `100vw` 는 세로 스크롤 막대를 포함해 JS 가
   * 잰 폭과 어긋난다. `useLayoutEffect` 라 그리기 전에 자리가 잡혀 한 번 튀지 않는다.
   */
  const anchorRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const width = Math.max(0, Math.min(PANEL_MAX_WIDTH, vw - 2 * PANEL_EDGE));
      const left = Math.max(PANEL_EDGE, Math.min(r.left, vw - PANEL_EDGE - width));
      setPlace({ left: left - r.left, width });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  const running = speakerState === "running" || state === "diarizing";

  /*
   * 바깥에서 온 **목록**이 바뀌면 목록 초안을 맞춘다. **패널이 닫혀 있을 때만.**
   *
   * 열려 있을 때 덮으면 적고 있던 목록이 폴링 한 번에 날아간다 — 나누는
   * 동안에는 몇 초마다 상세를 다시 물어보므로 그 일이 실제로 일어난다.
   * 목록은 번호에 매이지 않아 새 판이 와도 초안이 틀리지 않는다.
   */
  useEffect(() => {
    if (!open) setDraft(roster);
  }, [roster, open]);

  /*
   * **이름 초안은 판을 따라간다.** 열려 있어도.
   *
   * 이름 칸의 열쇠는 군집 번호이고 번호의 뜻은 판마다 바뀐다. 옛 판에서 적은 `1: 화자 가`
   * 를 새 판에 들고 가면 그건 다른 사람의 목소리다. 그래서 판이 바뀌면 손댄 칸을
   * 버린다 — 다만 **조용히 버리지 않는다.** 적고 있던 이름을 `resplit` 에 옮겨 "화자를
   * 다시 나눴습니다" 와 함께 보여 주고, 사람이 알맞은 목소리 칸에 다시 적게 한다.
   *
   * 판이 같으면(폴링이 같은 판을 다시 가져왔거나 에이전트가 이름만 고쳤으면) 손댄 칸은
   * 그대로 두고, 손대지 않은 칸만 서버 값을 따른다 (`edits` 에 없으니 저절로 그렇다).
   */
  useEffect(() => {
    const run = diarization?.run ?? null;
    if (run === editRun.current) return;
    const before = editRun.current;
    editRun.current = run;
    const touched = Object.keys(edits).length > 0 || dismissed.length > 0;
    setEdits({});
    setDismissed([]);
    // 처음 판을 받는 것(null → 판)은 바뀐 것이 아니다. 손댄 것이 없었으면 잃은 것도 없다.
    if (before !== null && touched) {
      setResplit({
        typed: [...new Set(Object.values(edits).map((v) => v.trim()).filter(Boolean))],
      });
      setError(null);
    }
  }, [diarization, edits, dismissed]);

  const tooLong =
    diar !== null &&
    duration !== null &&
    Number.isFinite(duration) &&
    duration > diar.maxAudioSeconds;

  const eta = estimateWork(duration, diar?.rtf, 0.27);

  /**
   * 인원 수가 그대로면 **같은 결과가 나온다.**
   *
   * 소리도 모델도 무리 수도 같으니 답이 달라질 데가 없다. 그 사실을 안 적으면
   * 이름만 바꾸려던 사람이 십몇 분짜리 나누기를 다시 돌린다. 막지는 않는다 —
   * 지난번에 끊겼거나 실패한 것을 다시 눌러 볼 수 있어야 한다.
   */
  const sameSize =
    diarization !== null &&
    speakerState !== "failed" &&
    diarization.roster.length === draft.length;

  const blocked = !diar
    ? "화자 분리 안내를 아직 못 받았습니다. 잠시 뒤에 다시 열어 주세요."
    : !diar.ready
      ? "화자 분리 모델이 아직 준비되지 않았습니다. 전사문은 그대로 나옵니다."
      : state !== "done"
        ? "전사가 끝나야 화자를 나눌 수 있습니다."
        : segments.length === 0
          ? "옮겨 적은 말이 없어 화자를 나눌 곳이 없습니다."
          : tooLong
            ? `${formatLength(duration)}짜리는 화자를 나누지 않습니다 (상한 ${formatLength(
                diar.maxAudioSeconds,
              )}). 이보다 길면 메모리를 다 써서 멈춥니다 — 전사문은 그대로입니다.`
            : null;

  const canRun = !blocked && draft.length > 0 && !starting && !running;

  const run = async () => {
    setError(null);
    setStarting(true);
    try {
      await api.diarize(recordingId, draft);
      setOpen(false);
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "화자 나누기를 시작하지 못했습니다");
    } finally {
      setStarting(false);
    }
  };

  const dirty = Object.keys(edits).length > 0 || dismissed.length > 0;

  const saveNames = async () => {
    if (!diarization || !dirty) return;
    setError(null);
    setSavingNames(true);
    try {
      const j = await api.speakerNames(recordingId, {
        // 이 초안이 어느 판의 번호인가. 서버가 지금 판과 견줘 다르면 409 로 막는다.
        run: editRun.current ?? diarization.run,
        names: edits,
        dismissRecheck: dismissed,
      });
      setEdits({});
      setDismissed([]);
      setResplit(null);
      onNamed(j.diarization ?? null, j.segments ?? []);
    } catch (e) {
      if (e instanceof HttpError && e.code === "stale-diarization") {
        /*
         * 서버의 판이 화면보다 앞섰다 (폴링이 새 판을 가져오기 전에 저장을 눌렀다).
         * 새 판을 곧바로 받아 온다 — 받아 오면 위의 효과가 손댄 칸을 걷어 "다시 나눴습니다"
         * 로 보여 준다. 그 전까지는 서버 문장을 띄워 둔다.
         */
        setError(e.message);
        onRefresh();
        return;
      }
      setError(e instanceof Error ? e.message : "이름을 저장하지 못했습니다");
    } finally {
      setSavingNames(false);
    }
  };

  /** 사람이 × 로 뺀 것을 뺀 "다시 확인" 목록. */
  const recheck = useMemo(() => {
    const gone = new Set(dismissed.map(nameKey));
    return (diarization?.recheckNames ?? []).filter((n) => !gone.has(nameKey(n)));
  }, [diarization, dismissed]);

  /** 이름 칸에서 고를 수 있는 이름. 목록 + 판이 바뀌어 걷어 낸 이름 (다시 적기 쉽게). */
  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    return [...roster, ...(resplit?.typed ?? []), ...recheck].filter((n) => {
      const k = nameKey(n);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [roster, resplit, recheck]);

  /** 말한 시간 많은 순. 이름을 나눠 줄 때 쓰는 순서가 이것이다. */
  const clusters = useMemo(() => diarization?.talkTime ?? [], [diarization]);

  return (
    <div ref={anchorRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setError(null);
        }}
        aria-expanded={open}
        title={
          running
            ? "지금 소리를 듣고 화자를 나누는 중입니다"
            : /*
                 못 나눈 이유가 있으면 **그것을 먼저 말한다.** 아래 갈래들은
                 "누르면 이런 일이 일어납니다" 인데, 지난번에 실패했다면 사람이
                 알아야 할 것은 그쪽이 아니라 무엇이 안 됐나이다.
               */
              speakerState === "failed" || speakerState === "skipped"
              ? (speakerError ?? "지난번에 화자를 못 나눴습니다")
              : diarization
                ? "목록을 고쳐 소리로 다시 나눕니다. 전사문은 그대로입니다"
                : "말한 사람 목록을 적으면 소리를 듣고 화자를 나눕니다"
        }
        className={cn(
          "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ring-1 transition",
          open
            ? "bg-(--color-accent-soft) text-(--color-accent-strong) ring-(--color-accent)/40"
            : "bg-(--color-surface) text-(--color-fg-2) ring-(--color-border-soft) hover:bg-(--color-surface-2)",
        )}
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
        {running ? "화자 나누는 중" : diarization ? "화자 · 다시 나누기" : "화자 나누기"}
        {/*
          실패했다는 것을 단추에서 이미 보인다. 패널을 열어야만 알 수 있으면
          아무도 안 연다 — 전사문은 멀쩡히 읽히니 뭔가 빠진 줄도 모른다.
        */}
        {!running && (speakerState === "failed" || speakerState === "skipped") && (
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--color-warn)"
            title="지난번에 화자를 못 나눴습니다"
          />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div
            data-speaker-panel
            // 자리는 위의 `measure` 가 정한다. 재기 전(첫 그리기)에는 단추 왼쪽 끝에 붙인다.
            style={place ? { left: place.left, width: place.width } : { left: 0 }}
            className="absolute top-full z-30 mt-2 max-h-[min(34rem,70vh)] w-[min(32rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg bg-(--color-surface-2) p-4 shadow-lg ring-1 ring-(--color-border-soft)"
          >
            <header className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs text-(--color-fg-2)">
                <Users className="h-3.5 w-3.5 text-(--color-accent-strong)" />
                말한 사람을 적어 주세요
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="닫기"
                className="rounded-full p-1 text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </header>

            {/*
              **"모르면 넉넉히 적으세요".** 비대칭이 분명하다 — 하나 모자라면
              −8.3pt, 하나 넉넉하면 +4.1pt. 문구는 서술자에서 온다.
            */}
            <p className="mb-2 text-[11px] leading-relaxed break-keep text-(--color-fg-4)">
              {diar?.rosterHint ??
                "말한 사람을 아는 대로 적어 주세요. 헷갈리면 넉넉히 적는 편이 낫습니다."}
            </p>

            {/* 올리기 화면과 같은 입력 칸이다 (`roster-input.tsx`). IME·중복 규칙이 한 곳에 산다. */}
            <RosterInput value={draft} onChange={setDraft} className="mb-2" />

            <p className="mb-3 text-[10.5px] leading-relaxed break-keep text-(--color-fg-4)">
              {/*
                여기 적은 이름이 곧바로 줄에 붙지 않는다는 말이 이 칸에서
                가장 중요하다. 안 적어 두면 사람은 목록 순서가 곧 화자 순서인
                줄 알고, 나눈 결과가 그 순서와 다르면 고장으로 본다.
                (실제로 음향 순서만으로 이름을 맞히면 64.9% 다 — 그래서 이름은
                나눈 뒤에 사람이 단다.)
              */}
              여기 적은 이름이 곧바로 줄에 붙는 것은 아닙니다 — 소리는 목소리를{" "}
              <b className="font-medium">가르기만</b> 하고, 어느 목소리가 누구인지는 나눈 뒤에
              아래에서 정합니다.
              {eta && ` · ${formatLength(duration)}짜리면 나누는 데 ${eta} 걸립니다.`}
            </p>

            {blocked && (
              <p className="mb-3 flex items-start gap-1.5 rounded-md bg-(--color-bg-2) px-3 py-2 text-[11px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-border-soft)">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-(--color-warn)" />
                <span className="min-w-0">{blocked}</span>
              </p>
            )}

            {!blocked && sameSize && (
              <p className="mb-3 rounded-md bg-(--color-bg-2) px-3 py-2 text-[11px] leading-relaxed break-keep text-(--color-fg-3) ring-1 ring-(--color-border-soft)">
                지난번과 인원 수가 같아 다시 돌려도 <b className="font-medium">같은 결과</b>가
                나옵니다. 이름만 바꾸려면 아래에서 고치세요.
              </p>
            )}

            {speakerError && (
              /*
                **전사가 실패한 것과 다른 일이다.** 전사문은 멀쩡히 있고
                화자만 못 붙은 상태라 붉은색이 아니다. 서버가 보낸 문장은
                그 자체로 완결되어 있으니 앞에 말을 덧붙이지 않는다.
              */
              <p className="mb-3 flex items-start gap-1.5 rounded-md bg-(--color-warn)/10 px-3 py-2 text-[11px] leading-relaxed break-keep text-(--color-warn) ring-1 ring-(--color-warn)/25">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0">{speakerError}</span>
              </p>
            )}

            {error && (
              <p className="mb-3 flex items-start gap-1.5 rounded-md bg-(--color-danger)/10 px-3 py-2 text-[11px] break-keep text-(--color-danger) ring-1 ring-(--color-danger)/30">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0">{error}</span>
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-[10.5px] break-keep text-(--color-fg-4)">
                {draft.length === 0 ? (
                  /*
                    단추가 꺼져 있는 이유를 적는다. 그냥 흐릿한 단추만 두면
                    사람은 고장으로 보고 몇 번 더 누른다.

                    한 명도 안 받는 길을 열지 않는 이유: 사람 수를 아예 안 주고
                    문턱으로 무리를 정하면 진짜 회의에서 화자가 40~134명 나온다.
                  */
                  <>한 명이라도 적어야 나눌 수 있습니다 — 사람 수를 모르면 목소리가 수십 갈래로 갈립니다</>
                ) : (
                  /*
                    다시 눌러도 잃는 것이 없다는 말이 여기 있어야 한다. "다시
                    전사" 와 나란히 선 단추라, 저쪽처럼 전사문을 날리는 줄 알면
                    아무도 안 누른다.
                  */
                  <>전사문은 그대로 있습니다 · 줄에서 직접 고친 화자는 안 덮습니다</>
                )}
              </span>
              <button
                type="button"
                onClick={() => void run()}
                disabled={!canRun}
                className="flex items-center gap-1.5 rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-medium text-(--color-bg) transition hover:bg-(--color-accent-strong) disabled:opacity-50"
              >
                {starting && <Loader2 className="h-3 w-3 animate-spin" />}
                {starting ? "시작하는 중" : diarization ? "다시 나누기" : "화자 나누기"}
              </button>
            </div>

            {clusters.length > 0 && (
              <section className="mt-4 border-t border-(--color-border-soft) pt-3">
                <h3 className="mb-1 text-[11.5px] text-(--color-fg-2)">이 녹음에서 갈린 목소리</h3>
                <p className="mb-2 text-[10.5px] leading-relaxed break-keep text-(--color-fg-4)">
                  말을 많이 한 순서입니다. 이름을 고치면{" "}
                  <b className="font-medium">그 목소리의 모든 줄</b>이 함께 바뀝니다. 비워 두면
                  “화자 1” 같은 임시 이름으로 돌아갑니다. 적어 주신 인원보다 많이 갈린 목소리는
                  전사문에 “{diar?.otherLabel ?? "other"}” 로 묶여 나옵니다.
                </p>
                {resplit && (
                  /*
                    **화자를 다시 나눴다.** 이름 칸의 번호가 새로 매겨져, 적고 있던 것을
                    저장하지 않고 걷어 냈다. 조용히 버리면 사람은 적은 이름이 왜 없어졌는지
                    모르고, 옛 칸 자리에 그대로 다시 적는다 — 그 자리는 이제 다른 목소리다.
                  */
                  <div
                    role="status"
                    className="mb-2 flex items-start gap-1.5 rounded-md bg-(--color-warn)/10 px-2.5 py-1.5 text-[11px] leading-relaxed break-keep text-(--color-warn) ring-1 ring-(--color-warn)/25"
                  >
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1">
                      화자를 다시 나눴습니다 — 이름을 확인해 주세요. 목소리 번호가 새로 매겨져
                      적고 계시던 것은 저장하지 않았습니다.
                      {resplit.typed.length > 0 && (
                        <>
                          {" "}
                          적으신 이름: <b className="font-medium">{resplit.typed.join(", ")}</b> —
                          알맞은 목소리 칸에 다시 적어 주세요.
                        </>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => setResplit(null)}
                      aria-label="안내 닫기"
                      className="shrink-0 rounded-full p-0.5 transition hover:bg-(--color-warn)/15"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
                {recheck.length > 0 && (
                  /*
                    **다시 확인해 주세요.** 다시 나누며 어느 목소리인지 뚜렷하게
                    짝짓지 못해 옮기지 않은, 사람이 붙인 이름이다. 이름 칸 바로 위에
                    두는 것은 여기서 붙이고 저장하면 끝나는 일이라서다.

                    저장해도 **다룬 이름만** 빠진다 — 칸에 붙였거나 × 로 뺀 것. 상관없는
                    이름 하나를 고쳐 저장했다고 나머지가 사라지면, 사람은 그 이름들을 본
                    적도 없이 잃는다 (`setDiarNames`).
                  */
                  <div className="mb-2 flex items-start gap-1.5 rounded-md bg-(--color-warn)/10 px-2.5 py-1.5 text-[11px] leading-relaxed break-keep text-(--color-warn) ring-1 ring-(--color-warn)/25">
                    <UserRoundSearch className="mt-0.5 h-3 w-3 shrink-0" />
                    <span className="min-w-0">
                      다시 확인해 주세요 — 다시 나누면서 아래 이름을 어느 목소리에 붙일지 뚜렷하지
                      않아 옮기지 않았습니다. 알맞은 목소리 칸에 적고 “이름 저장” 을 누르면 그
                      이름이 여기서 빠집니다. 이 녹음에 없는 사람이면 × 로 빼고 저장하세요.
                      <span className="mt-1 flex flex-wrap gap-1">
                        {recheck.map((n) => (
                          <span
                            key={n}
                            className="flex items-center gap-0.5 rounded-full bg-(--color-surface) py-0.5 pr-0.5 pl-2 text-(--color-fg-2) ring-1 ring-(--color-warn)/30"
                          >
                            {n}
                            <button
                              type="button"
                              onClick={() => setDismissed((prev) => [...prev, n])}
                              aria-label={`${n} 을(를) 다시 확인 목록에서 빼기`}
                              className="rounded-full p-0.5 text-(--color-fg-4) transition hover:bg-(--color-surface-hi) hover:text-(--color-fg-2)"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        ))}
                      </span>
                    </span>
                  </div>
                )}
                <ul className="flex flex-col gap-1.5">
                  {clusters.map((t, i) => {
                    const key = String(t.k);
                    /*
                      **말한 시간 상위 L개에만 이름을 주고 나머지는 `other` 다.**
                      그 규칙은 신탁과 0.1pt 이내다. 실루엣으로 고르면 목록에
                      적은 사람 말의 30%를 버리고 18.6pt 를 깎는다 — 하지 마라.
                    */
                    const beyond =
                      diarization !== null &&
                      diarization.roster.length > 0 &&
                      i >= diarization.roster.length;
                    /*
                      **본문이 쓰는 이름 그대로** 색을 찾는다. 여기서 순위로
                      색을 새로 매기면 같은 사람이 본문과 여기서 다른 색을 갖고,
                      그러면 이 목록은 짝을 맞추는 데 쓸 수 없게 된다.
                    */
                    const shown = namer(t.k) ?? `화자 ${i + 1}`;
                    const st = speakers.get(shown.trim()) ?? null;
                    return (
                      <li key={key} className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="h-4 w-0 shrink-0"
                          style={{
                            borderLeftColor: st?.color ?? "var(--color-border-soft)",
                            borderLeftStyle: st?.lineStyle ?? "solid",
                            borderLeftWidth: st?.lineWidth ?? 3,
                          }}
                        />
                        <input
                          // 손댄 칸은 사람이 적은 것, 안 댄 칸은 서버의 지금 값.
                          value={key in edits ? edits[key] : (diarization?.names[key] ?? "")}
                          onChange={(e) =>
                            setEdits((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          list="voice-roster-names"
                          maxLength={40}
                          placeholder={shown}
                          className="min-w-0 flex-1 rounded-md bg-(--color-surface) px-2.5 py-1 text-[11.5px] text-(--color-fg) ring-1 ring-(--color-border-soft) outline-none focus:ring-(--color-accent)/60"
                          aria-label={`${i + 1}번째로 많이 말한 목소리 (지금 이름: ${shown})`}
                        />
                        {beyond && (
                          /*
                            목록 인원 바깥. **말한 시간 상위 L개에만 이름을 주고
                            나머지는 `other`** 라는 규칙이 여기 보인다 (신탁과
                            0.1pt 이내). 표시가 없으면 사람은 왜 이 칸만 이름이
                            다른지 모른다. 그래도 손으로 이름을 줄 수는 있다 —
                            빠뜨린 사람이 여기 앉아 있을 수 있다.
                          */
                          <span className="shrink-0 rounded-full bg-(--color-bg-2) px-1.5 py-0.5 text-[10px] text-(--color-fg-4) ring-1 ring-(--color-border-soft)">
                            목록 밖
                          </span>
                        )}
                        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-(--color-fg-4)">
                          {formatLength(t.seconds)}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                {/* 적어 둔 목록 · 다시 확인할 이름 · 걷어 낸 이름을 이름 칸에서 곧바로 고를 수 있게. */}
                <datalist id="voice-roster-names">
                  {suggestions.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>

                <div className="mt-2 flex items-center justify-end gap-2">
                  <span className="mr-auto text-[10.5px] break-keep text-(--color-fg-4)">
                    소리는 목소리를 가르기만 합니다. 누구인지는 사람이 정합니다.
                  </span>
                  <button
                    type="button"
                    onClick={() => void saveNames()}
                    // 손댄 것이 없으면 보낼 것도 없다. 빈 저장이 "다시 확인" 을 건드릴 일도 없다.
                    disabled={savingNames || !dirty}
                    className="flex items-center gap-1.5 rounded-full bg-(--color-bg-2) px-3 py-1 text-[11px] text-(--color-fg-2) ring-1 ring-(--color-border-soft) transition hover:bg-(--color-surface-hi) disabled:opacity-50"
                  >
                    {savingNames ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    이름 저장
                  </button>
                </div>
              </section>
            )}

            {/*
              출처 고지. **장식이 아니라 의무다** — 분할 모델이 MIT 이고
              MIT 는 저작권 표시를 함께 실을 것을 요구한다. 문장은 서술자에서
              온다 (`diarAttribution`).
            */}
            {diar?.attribution && (
              <p className="mt-3 border-t border-(--color-border-soft) pt-2 text-[10px] leading-relaxed break-keep text-(--color-fg-4)">
                {diar.attribution}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
