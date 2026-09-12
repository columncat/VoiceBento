#!/usr/bin/env node
/**
 * 모델을 볼륨에 내려받는다. 이미 있으면 아무것도 안 한다.
 *
 * 받는 것이 둘이다 — **전사 모델**(parakeet, 671MB)과 **화자 분리 모델**
 * (분할 + 임베딩, 34.3MB). 둘은 서로 다른 서술자를 보고, 서로 다른 자리에
 * 앉을 수 있으며, **한쪽이 없어도 다른 쪽은 돈다.**
 *
 * 그 갈라짐이 이 스크립트의 뼈대다: 전사 모델이 없으면 이 앱은 할 일이
 * 없지만(실패로 끝낸다), **분리 모델이 없으면 화자 구분만 못 하고 전사는
 * 그대로 된다**(말만 하고 성공으로 끝낸다). 그래서 분리 쪽 실패는 이
 * 스크립트를 넘어뜨리지 않는다.
 *
 * ## 무엇을 받나 — **서술자가 정한다**
 *
 * 주소도 크기도 sha256 도 여기 박혀 있지 않다. 옆의 `asr-models.json` 과
 * `diar-models.json` 에서 읽는다 (`ASR_MODEL_ID`·`DIAR_MODEL_ID` 가 고르고,
 * 비면 표의 기본값). 그 파일들이 앱과 워커와 이 스크립트가 함께 보는
 * **하나의 자리**다 — 모델을 갈아 끼울 때 고칠 곳이 하나여야 한다.
 *
 * ## 왜 이미지에 굽지 않는가
 *
 * 풀면 671MB 다. 런타임 이미지가 562MB 에서 1.7GB 로 뛴다 — 형제 앱들이
 * 475~494MB 인데 이 앱만 세 배가 될 이유가 없다. 게다가 모델은 앱 코드와
 * 달리 배포마다 바뀌지 않는다. 이미지를 열 번 새로 만들어도 같은 671MB 를
 * 열 번 내려받고 열 번 저장하는 셈이다.
 *
 * 그래서 볼륨에 두고, 이 스크립트가 없을 때만 받는다. 컨테이너 진입점이
 * 시작할 때 한 번 부른다.
 *
 * ## 라이선스 — 지우지 마라
 *
 * 원본 가중치 `nvidia/parakeet-tdt-0.6b-v3` 는 **CC-BY-4.0** 이다.
 * 출처를 밝힐 의무가 따라온다 (README 에 적어 두었고, 화면에도 적는다).
 * sherpa-onnx 와 `sherpa-onnx-node` 는 Apache-2.0.
 *
 * 분리 쪽 분할 모델 `pyannote/segmentation-3.0` 은 **MIT (Copyright (c) 2022
 * CNRS)** 라 저작권 표시를 함께 실어야 한다. 임베딩 `3D-Speaker CAM++` 는
 * Apache-2.0. **Reverb 계열은 쓰지 않는다** — Rev Non-Production License 가
 * hosted service 를 금지하는데 `/voice` 가 정확히 그것이고 이 저장소는 공개다.
 * 그 규율은 주석이 아니라 코드로 막아 두었다 (`src/lib/diar-models.ts` 의
 * 라이선스 허용 목록 검사 — 어기면 앱이 안 뜬다).
 *
 * 실행: `npm run model:fetch` (환경변수 `MODEL_DIR`, 기본 ./data/models)
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/*
 * 자리가 둘이다. **`src/lib/env.ts` 의 `modelPaths` 와 같은 규칙이어야 한다.**
 *
 * - 이 앱 혼자 돌 때: `MODEL_DIR` 한 폴더에 모델과 VAD 를 함께 두고, 없으면
 *   여기서 받는다.
 * - bento 스택에 얹혔을 때: `bootstrap.sh` 가 호스트에서 미리 받아 두고
 *   compose 가 **읽기 전용**으로 물린다. 그때 `ASR_MODEL_DIR` 이 그 자리를
 *   가리키고, VAD 는 그 폴더 밖(`VAD_MODEL_PATH`)에 있다.
 *
 * 둘째 경우에는 **아무것도 받지 않는다.** 읽기 전용이라 쓸 수도 없고(쓰려
 * 들면 EROFS 로 죽는다), 호스트가 이미 받아 둔 671MB 를 한 번 더 받을 이유도
 * 없다. 대신 있는지 보고 없으면 그 사실을 말한다 — 진입점은 이 실패를
 * 흘려보내므로 앱은 그대로 뜨고 전사만 실패한다.
 */
const EXTERNAL_DIR = process.env.ASR_MODEL_DIR?.trim();
const MODEL_DIR = resolve(EXTERNAL_DIR || process.env.MODEL_DIR || "./data/models");
const EXTERNAL_VAD = process.env.VAD_MODEL_PATH?.trim();

function log(...args) {
  console.log("[fetch-model]", ...args);
}

/**
 * 서술자 표. **앱·워커와 같은 파일을 읽는다.**
 *
 * 크기와 sha256 은 실제로 받아 확인한 값이다. **둘 다 검사한다** —
 * 크기만 보면 앞단이 끼워 넣은 오류 페이지가 우연히 같은 크기일 수 있고,
 * 해시만 보면 671MB 를 다 받고 나서야 잘못된 것을 안다.
 */
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

const TABLE = JSON.parse(readFileSync(join(SCRIPT_DIR, "asr-models.json"), "utf8"));

const MODEL_ID = process.env.ASR_MODEL_ID?.trim() || TABLE.default;
const MODEL = TABLE.models[MODEL_ID];
if (!MODEL) {
  console.error(
    `[fetch-model] 모르는 모델 id 입니다: "${MODEL_ID}". ` +
      `아는 것: ${Object.keys(TABLE.models).join(", ")} (scripts/asr-models.json)`,
  );
  process.exit(1);
}

/**
 * 받을 것과, 풀면 나와야 하는 파일들.
 *
 * `produces` 를 손으로 적지 않는다 — 서술자의 `runtime.files` 가 이미 그
 * 목록이다. 두 벌로 두면 모델을 바꾸며 한쪽만 고치는 날이 오고, 그러면
 * "받았다" 고 하고서 워커가 "파일이 없습니다" 로 죽는다.
 */
const ARCHIVE = MODEL.download?.archive
  ? {
      ...MODEL.download.archive,
      produces: Object.values(MODEL.runtime.files),
    }
  : null;

const VAD = { ...TABLE.vad };

// ─────────────────────────────────────────────────────────────
//   화자 분리 모델
// ─────────────────────────────────────────────────────────────

/**
 * 분리 모델의 자리. **전사 모델과 갈라 둔다.**
 *
 * `src/lib/env.ts` 의 `diarPaths` 와 **같은 규칙이어야 한다.** 요는 하나다:
 * `ASR_MODEL_DIR` 이 주어져 있어도 그것으로 분리 모델 자리를 짐작하지 않는다.
 *
 * 스택 배포에서 전사 모델은 `/models/sherpa-onnx-nemo-parakeet-…` 안에 있고
 * VAD 는 그 한 칸 위에 있다. 분리 모델이 어디 앉을지는 `bootstrap.sh` 가
 * 정하는 것이지 우리가 `..` 를 붙여 맞힐 일이 아니다 — 맞히려 들면, 스택이
 * 아직 분리 모델을 모르는 배포에서 **읽기 전용 자리에 쓰려다 EROFS 로 죽는다.**
 *
 * 그래서 `DIAR_MODEL_DIR` 을 따로 받고, 없으면 **이 앱이 쓸 수 있는 볼륨**
 * (`MODEL_DIR`, 도커에서는 /app/data/models)에 34.3MB 를 받는다. 그 편이
 * 좋은 성질을 하나 준다 — 이미 돌고 있는 스택이 설정 한 줄 안 바꾸고도
 * 화자 분리를 갖게 된다.
 */
const DIAR_EXTERNAL_DIR = process.env.DIAR_MODEL_DIR?.trim();
const DIAR_DIR = resolve(DIAR_EXTERNAL_DIR || process.env.MODEL_DIR || "./data/models");

const DIAR_TABLE = JSON.parse(readFileSync(join(SCRIPT_DIR, "diar-models.json"), "utf8"));
const DIAR_MODEL_ID = process.env.DIAR_MODEL_ID?.trim() || DIAR_TABLE.default;
const DIAR_MODEL = DIAR_TABLE.models[DIAR_MODEL_ID];

/**
 * 이 모델이 쓰는 파일 둘. 서술자의 `files` 를 이름으로 가리킨다.
 *
 * `DIAR_MODEL` 이 없으면(오타 난 id) 여기서 터뜨리지 않는다 — 분리 쪽의
 * 잘못이 전사 모델 내려받기를 넘어뜨리면 안 된다. 아래 `fetchDiar()` 가
 * 그 사실을 말하고 넘어간다. 앱은 뜰 때 `getDiarModel()` 이 같은 오타를
 * 잡아 준다.
 */
const DIAR_FILES = DIAR_MODEL
  ? [DIAR_TABLE.files[DIAR_MODEL.segmentationFile], DIAR_TABLE.files[DIAR_MODEL.embeddingFile]]
  : [];

/**
 * 내려받으면서 해시를 함께 센다.
 *
 * 다 받고 나서 파일을 다시 읽어 해시하면 671MB 를 두 번 읽는다. 흘러가는
 * 김에 세면 한 번이면 된다.
 *
 * 받는 동안에는 `.part` 이름으로 두고 검사를 통과한 뒤에 제자리로 옮긴다.
 * 중간에 끊긴 파일이 완성품 이름으로 남으면, 다음에 뜰 때 "이미 있다" 로
 * 보고 넘어가 버린다.
 */
async function download(url, dest, expect) {
  const part = `${dest}.part`;
  log(`받는 중: ${basename(dest)} (${(expect.size / 1e6).toFixed(0)}MB)`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`내려받기 실패 (${res.status}): ${url}`);
  }

  const hash = createHash("sha256");
  let received = 0;
  let lastLog = Date.now();

  const source = Readable.fromWeb(res.body);
  source.on("data", (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    // 10초에 한 번만. 로그가 진행 막대가 되면 도커 로그가 못 쓰게 된다.
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      log(`  ${(received / 1e6).toFixed(0)} / ${(expect.size / 1e6).toFixed(0)}MB`);
    }
  });

  await pipeline(source, createWriteStream(part));

  const got = hash.digest("hex");
  if (received !== expect.size) {
    await rm(part, { force: true });
    throw new Error(`크기가 다릅니다: ${received} ≠ ${expect.size} (${url})`);
  }
  if (got !== expect.sha256) {
    await rm(part, { force: true });
    throw new Error(`sha256 이 다릅니다: ${got} ≠ ${expect.sha256} (${url})`);
  }

  await rename(part, dest);
  log(`  받았습니다: ${basename(dest)}`);
}

/**
 * `tar -xjf`.
 *
 * Node 에는 bzip2 를 푸는 것이 없다. 런타임 이미지에 `bzip2` 를 넣어 둔
 * 이유가 이것 하나다 (수백 KB 라 값이 없는 것이나 마찬가지다).
 *
 * `--strip-components=1` 로 감싸고 있는 폴더를 벗긴다. 그러면
 * `MODEL_DIR/encoder.int8.onnx` 가 되어 워커가 아는 자리에 그대로 앉는다.
 */
function extract(archive, dir) {
  return new Promise((res, rej) => {
    /*
     * 묶음 이름만 넘기고 **작업 폴더를 옮겨서** 부른다.
     *
     * `-C <절대경로>` 로도 되지만, GNU tar 은 `C:/…` 꼴을 **원격 호스트**로
     * 읽는다 (`Cannot connect to C: resolve failed`). 리눅스에서는 안 나는
     * 일이지만 개발이 윈도에서 이뤄지므로 여기서 막아 둔다. cwd 를 옮기면
     * 드라이브 문자가 명령줄에 아예 안 실린다.
     */
    const tar = spawn("tar", ["-xjf", basename(archive), "--strip-components=1"], {
      cwd: dir,
      stdio: ["ignore", "inherit", "inherit"],
    });
    tar.on("error", (e) =>
      rej(
        new Error(
          e.code === "ENOENT"
            ? "tar 을 찾지 못했습니다. 이미지에 tar 과 bzip2 가 있어야 합니다."
            : `tar 을 띄우지 못했습니다: ${e.message}`,
        ),
      ),
    );
    tar.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`tar 이 ${code} 로 끝났습니다 (bzip2 가 없나요?)`)),
    );
  });
}

async function fileHasSize(path, size) {
  try {
    return (await stat(path)).size === size;
  } catch {
    return false;
  }
}

/**
 * 스택이 물려 준 자리를 확인만 한다. **받지 않는다.**
 *
 * 여기서 없다고 나오면 `bootstrap.sh` 가 모델을 못 받은 것이다. 그 사실을
 * 그대로 말하고 실패로 끝낸다 — 진입점이 이 실패를 흘려보내므로 앱은 뜬다.
 * 조용히 내려받기로 넘어가면 읽기 전용 마운트에 쓰다 EROFS 로 죽거나,
 * 운 나쁘게 쓰기가 되는 배포에서는 같은 671MB 가 두 벌이 된다.
 */
async function checkExternal() {
  const expected = Object.values(MODEL.runtime.files);
  const missing = expected.filter((f) => !existsSync(join(MODEL_DIR, f)));
  const vadPath = EXTERNAL_VAD ? resolve(EXTERNAL_VAD) : join(MODEL_DIR, VAD.name);
  if (!existsSync(vadPath)) missing.push(vadPath);

  if (missing.length) {
    throw new Error(
      `모델 자리(ASR_MODEL_DIR=${MODEL_DIR})에 파일이 없습니다: ${missing.join(", ")}. ` +
        `이 자리는 스택이 채웁니다 — 호스트에서 \`./bootstrap.sh\` 를 다시 돌리세요. ` +
        `(읽기 전용으로 물린 자리라 앱이 직접 받지 않습니다.)`,
    );
  }
  log(`스택이 물려 준 모델을 씁니다: ${MODEL_DIR}`);
  log(`  VAD: ${vadPath}`);
}

/**
 * 자리에 앉아 있는 파일의 sha256.
 *
 * 내려받는 동안 흘러가는 김에 세는 것(`download`)과 달리, 이쪽은 **묶음에서
 * 꺼낸 뒤** 확인하려고 있다. 묶음 해시는 내려받기가 온전했는지만 말해 주고,
 * tar 이 무엇을 꺼내 놓았는지는 말해 주지 않는다.
 */
async function sha256OfFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * 묶음에서 **한 멤버만** 꺼내 우리가 정한 이름으로 앉힌다.
 *
 * 전사 모델 쪽 `extract()` 와 갈라 둔 이유가 둘이다.
 *
 * 1. 이 묶음 안의 파일 이름이 `model.onnx` 다. 너무 흔해서, 다른 모델 파일과
 *    한 폴더에 두면 무엇의 model 인지 알 수 없다. 서술자가 정한 이름
 *    (`pyannote-segmentation-3-0.onnx`)으로 바꿔 앉힌다.
 * 2. 묶음에는 `model.int8.onnx` 와 파이썬 예제들이 함께 들어 있다. 우리가
 *    쓰는 것은 fp32 하나뿐이라 나머지를 볼륨에 남길 이유가 없다.
 *
 * 풀 자리를 임시 폴더로 두는 것도 그 때문이다 — 모델 폴더에 곧바로 풀면
 * 실패했을 때 반쯤 풀린 것들이 남는다.
 *
 * cwd 를 옮겨서 부르는 까닭은 전사 쪽과 같다: GNU tar 이 `C:/…` 을 원격
 * 호스트로 읽는다 (개발이 윈도에서 이뤄진다).
 */
function extractMember(archive, member, unpackDir) {
  return new Promise((res, rej) => {
    const tar = spawn(
      "tar",
      ["-xjf", basename(archive), "--strip-components=1", member],
      { cwd: unpackDir, stdio: ["ignore", "inherit", "inherit"] },
    );
    tar.on("error", (e) =>
      rej(
        new Error(
          e.code === "ENOENT"
            ? "tar 을 찾지 못했습니다. 이미지에 tar 과 bzip2 가 있어야 합니다."
            : `tar 을 띄우지 못했습니다: ${e.message}`,
        ),
      ),
    );
    tar.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`tar 이 ${code} 로 끝났습니다 (bzip2 가 없나요?)`)),
    );
  });
}

/** 분리 파일 하나를 받아 제자리에 앉힌다. 이미 크기가 맞으면 아무것도 안 한다. */
async function fetchDiarFile(file) {
  const dest = join(DIAR_DIR, file.name);
  if (await fileHasSize(dest, file.size)) {
    log(`  이미 있습니다: ${file.name}`);
    return;
  }

  if (file.download.kind === "direct") {
    // 받는 것이 곧 쓰는 것이다. `download` 가 흘러가는 김에 해시를 센다.
    await download(file.download.url, dest, { size: file.size, sha256: file.sha256 });
    return;
  }

  // ── 묶음 ──
  const unpackDir = join(DIAR_DIR, ".diar-unpack");
  const archive = join(unpackDir, basename(file.download.url));
  try {
    await mkdir(unpackDir, { recursive: true });
    await download(file.download.url, archive, file.download);
    await extractMember(archive, file.download.member, unpackDir);

    const produced = join(unpackDir, basename(file.download.member));
    if (!existsSync(produced)) {
      throw new Error(`묶음에서 ${file.download.member} 를 꺼내지 못했습니다.`);
    }
    /*
     * 꺼낸 것이 정말 그 파일인지 본다. 묶음 해시가 맞았어도 여기서 다시
     * 보는 이유는, 묶음 해시는 "받은 바이트" 를 말할 뿐 "꺼낸 멤버" 를
     * 말하지 않기 때문이다. 멤버 이름을 잘못 적으면 엉뚱한 파일이 모델
     * 이름을 달고 앉는다 — 그러면 sherpa 가 뜰 때 알아볼 수 없는 C++
     * 예외로 죽는다.
     */
    const got = await sha256OfFile(produced);
    if (got !== file.sha256) {
      throw new Error(`${file.download.member} 의 sha256 이 다릅니다: ${got} ≠ ${file.sha256}`);
    }
    await rename(produced, dest);
    log(`  앉혔습니다: ${file.name}`);
  } finally {
    // 묶음도 풀다 만 것도 남기지 않는다. 성공이든 실패든 마찬가지다.
    await rm(unpackDir, { recursive: true, force: true });
  }
}

/**
 * 스택이 물려 준 분리 모델 자리를 확인만 한다. **받지 않는다.**
 *
 * 전사 쪽 `checkExternal()` 과 같은 이유다 — 읽기 전용으로 물린 자리다.
 */
function checkDiarExternal() {
  const missing = DIAR_FILES.filter((f) => !existsSync(join(DIAR_DIR, f.name)));
  if (missing.length) {
    throw new Error(
      `분리 모델 자리(DIAR_MODEL_DIR=${DIAR_DIR})에 파일이 없습니다: ` +
        `${missing.map((f) => f.name).join(", ")}. 이 자리는 스택이 채웁니다 — ` +
        `호스트에서 \`./bootstrap.sh\` 를 다시 돌리거나, DIAR_MODEL_DIR 을 비워 ` +
        `앱이 직접 받게 하세요. (읽기 전용으로 물린 자리라 앱이 쓰지 않습니다.)`,
    );
  }
  log(`스택이 물려 준 분리 모델을 씁니다: ${DIAR_DIR}`);
  for (const f of DIAR_FILES) log(`  ${f.name}`);
}

/**
 * 화자 분리 모델. **여기서 실패해도 이 스크립트는 성공으로 끝난다.**
 *
 * 전사문이 화자 분리보다 먼저다. 분리 모델이 없으면 화자 구분만 못 하고
 * 전사는 그대로 된다 — 그 사실을 말하고 넘어가는 것이 여기서 할 일의
 * 전부다. 예전처럼 통째로 실패로 끝내면 진입점이 "전사만 실패하고 앱은
 * 그대로 뜹니다" 를 찍는데, 그건 거짓말이 된다 (전사는 멀쩡하다).
 */
async function fetchDiar() {
  if (process.env.AUTO_FETCH_DIAR_MODEL === "0") {
    log("화자 분리 모델 내려받기가 꺼져 있습니다 (AUTO_FETCH_DIAR_MODEL=0).");
    return;
  }
  if (!DIAR_MODEL) {
    log(
      `! 모르는 화자 분리 모델 id 입니다: "${DIAR_MODEL_ID}". ` +
        `아는 것: ${Object.keys(DIAR_TABLE.models).join(", ")} (scripts/diar-models.json)`,
    );
    return;
  }
  const total = DIAR_FILES.reduce((a, f) => a + f.size, 0);
  log(`화자 분리 모델: ${DIAR_MODEL.name} (${DIAR_MODEL_ID}, ${(total / 1e6).toFixed(1)}MB)`);

  try {
    if (DIAR_EXTERNAL_DIR) {
      checkDiarExternal();
      return;
    }
    await mkdir(DIAR_DIR, { recursive: true });
    for (const f of DIAR_FILES) await fetchDiarFile(f);
    log(`화자 분리 모델 준비 완료: ${DIAR_DIR}`);
  } catch (e) {
    log(`! 화자 분리 모델을 준비하지 못했습니다: ${e instanceof Error ? e.message : e}`);
    log("! 화자 구분만 못 합니다. 전사는 그대로 됩니다.");
  }
}

/** 전사 모델. **없으면 이 앱은 할 일이 없다** — 여기서 던지면 실패로 끝난다. */
async function fetchAsr() {
  log(`전사 모델: ${MODEL.name} (${MODEL_ID})`);
  if (EXTERNAL_DIR) return checkExternal();

  await mkdir(MODEL_DIR, { recursive: true });

  // ── 모델 본체 ──
  const expected = Object.values(MODEL.runtime.files);
  const haveModel = expected.every((f) => existsSync(join(MODEL_DIR, f)));
  if (haveModel) {
    log("모델이 이미 있습니다. 건너뜁니다.");
  } else if (!ARCHIVE) {
    /*
     * 내려받기 표에 없는 모델이다. **여기서 지어내지 않는다.**
     *
     * 주소와 크기와 sha256 은 실제로 받아 확인한 값이어야 한다. 짐작해서
     * 적으면 검사가 통과하는 것이 아니라 **검사가 거짓말이 된다** — 엉뚱한
     * 파일을 받고도 "확인했습니다" 가 뜬다. 그러니 없으면 없다고 말한다.
     */
    throw new Error(
      `"${MODEL_ID}" 는 자동으로 받는 표에 없습니다. 파일을 ${MODEL_DIR} 에 손으로 넣거나, ` +
        `scripts/asr-models.json 의 download 칸에 실제로 받아 확인한 주소·크기·sha256 을 ` +
        `적어 주세요. 필요한 파일: ${expected.join(", ")}`,
    );
  } else {
    const archive = join(MODEL_DIR, "model.tar.bz2");
    if (!(await fileHasSize(archive, ARCHIVE.size))) {
      await download(ARCHIVE.url, archive, ARCHIVE);
    } else {
      log("내려받은 묶음이 이미 있습니다. 푸는 것만 다시 합니다.");
    }
    log(`푸는 중… (${ARCHIVE.unpackedLabel ?? "…"})`);
    await extract(archive, MODEL_DIR);
    // 다 풀었으면 묶음은 필요 없다. 487MB 를 볼륨에 남겨 둘 이유가 없다.
    await rm(archive, { force: true });

    const missing = ARCHIVE.produces.filter((f) => !existsSync(join(MODEL_DIR, f)));
    if (missing.length) {
      throw new Error(`풀었는데 파일이 없습니다: ${missing.join(", ")}`);
    }
    log("모델 준비 완료.");
  }

  // ── VAD ──
  const vadPath = join(MODEL_DIR, VAD.name);
  if (await fileHasSize(vadPath, VAD.size)) {
    log("silero VAD 가 이미 있습니다. 건너뜁니다.");
  } else {
    await download(VAD.url, vadPath, VAD);
  }

  log(`전사 모델 준비 완료: ${MODEL_DIR}`);
}

/**
 * 둘을 챙긴다. **전사가 실패해도 분리는 챙겨 본다.**
 *
 * 순서를 그렇게 잡은 이유가 있다. 전사 모델이 없는 것은 대개 671MB 를
 * 받다 끊긴 것이고, 그 끊김이 34MB 짜리 둘까지 못 받게 할 까닭이 없다.
 * 다음번에 뜰 때 전사 것만 이어 받으면 된다.
 *
 * 끝내는 값은 **전사 쪽만** 본다. 분리 쪽은 제 안에서 실패를 삼킨다
 * (`fetchDiar`).
 */
async function main() {
  let asrError = null;
  try {
    await fetchAsr();
  } catch (e) {
    asrError = e;
  }
  await fetchDiar();
  if (asrError) throw asrError;
}

main().catch((e) => {
  console.error("[fetch-model] 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
