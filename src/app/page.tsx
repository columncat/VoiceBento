import { RecordingList } from "@/components/recording-list";
import { env } from "@/lib/env";
import { MODEL_NOTICE } from "@/lib/model";
import { listRecordings } from "@/lib/recording-server";
import { listSessions } from "@/lib/session-server";

/**
 * 녹음 목록. 이 앱의 첫 화면.
 *
 * 여기서 하는 일은 **읽어서 넘기는 것뿐이다.** 상태는 `<RecordingList>` 가
 * 전부 들고, 이 파일은 서버에서만 할 수 있는 일(DB 읽기, 환경변수)만 한다 —
 * 형제 앱들의 3단 분리를 그대로 따른다.
 *
 * 첫 목록을 서버에서 실어 보내는 것은 **첫 화면이 안 깜빡이게** 하려는 것이다.
 * 붙자마자 화면이 한 번 더 물어보므로(그 사이에 전사가 진행됐을 수 있다) 이
 * 값이 조금 낡아도 된다.
 *
 * `force-dynamic` 인 것은 목록이 사람과 전사 워커 양쪽에서 바뀌기 때문이다.
 * 정적으로 굳으면 새로고침해도 옛 목록이 나온다.
 *
 * ## 세션도 여기서 함께 실어 보낸다
 *
 * 목록을 **세션별로 묶어** 그리는 것이 기본이라, 세션이 늦게 오면 첫 화면이
 * 평평한 격자로 한 번 그려졌다가 묶음으로 다시 접힌다. 그 한 번의 접힘이
 * 카드 자리를 통째로 옮겨서, 마침 누르려던 카드가 손가락 밑에서 도망간다.
 * 서버에서 함께 읽어 보내면 처음부터 묶여 나온다.
 */
export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <RecordingList
      initial={{
        recordings: listRecordings(),
        sessions: listSessions(),
        model: MODEL_NOTICE,
      }}
      /*
       * 형제 앱으로 건너가는 주소.
       *
       * 한 도메인을 경로로 나눠 쓰는 배포(`bento…/mail`·`/memo`·`/paper`)에서는
       * 화면이 호스트만 보고 경로를 맞힐 수 없다. 그래서 전체 주소를 환경변수로
       * 준다 — 비어 있으면 화면이 하위 도메인 규칙으로 유추한다.
       *
       * `MEMOBENTO_URL` 은 **사람이 누르는 주소다.** 서버가 파일을 주고받는
       * 주소는 `MEMOBENTO_API_URL` 로 따로 있다 (`lib/env.ts`). 둘을 하나로
       * 합치면 둘 중 하나가 반드시 틀린다 — 컨테이너 주소를 브라우저에 주면
       * 링크가 죽고, 바깥 주소로 파일을 나르면 터널을 한 바퀴 돌아 나간다.
       */
      mailbentoUrl={env.MAILBENTO_URL?.trim() || null}
      memobentoUrl={env.MEMOBENTO_URL?.trim() || null}
      paperbentoUrl={env.PAPERBENTO_URL?.trim() || null}
    />
  );
}
