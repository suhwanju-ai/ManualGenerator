# DB 설계 문서 — Manual Capture

> 프로젝트 개요는 → [시스템 아키텍처](system-architecture.md) 참고.

## 1. 저장소 개요

이 확장은 관계형 DB를 사용하지 않습니다. 모든 상태는 Chrome 확장 API인 **`chrome.storage.local`** 에 키-값 형태로 저장됩니다.

| 항목 | 값 |
|---|---|
| 저장 엔진 | `chrome.storage.local` (브라우저 로컬, IndexedDB 기반) |
| 데이터 형식 | JSON 직렬화 가능한 키-값 |
| 용량 제한 | `unlimitedStorage` 권한으로 무제한 (스크린샷 base64 보관 대응) |
| 영속성 | 브라우저/기기 로컬. 동기화·서버 전송 없음 |
| 동시성 제어 | 애플리케이션 레벨 Promise 직렬화 큐 (§4) |

> **왜 storage인가**: MV3 service worker(`background.js`)는 휘발성이라 유휴 시 종료됩니다. 따라서 상태/단계는 메모리가 아니라 반드시 `chrome.storage.local`에 보관합니다 — 이것이 단일 진실 공급원(single source of truth)입니다.

---

## 2. 키(테이블) 목록

`chrome.storage.local`의 최상위 키를 논리적 "테이블"로 봅니다.

| 키 | 타입 | 한글 설명 | 예상 레코드 |
|---|---|---|---|
| `recording` | boolean | 녹화 진행 상태 플래그 | 1 (단일 값) |
| `recordingTabId` | number\|null | 녹화 시작 시점의 활성 탭 id (수동 캡처가 다른 탭을 찍으면 경고용) | 1 |
| `steps` | array<Step> | 수집된 단계 목록 (핵심 데이터) | 0~수백 |
| `provider` | string | 현재 선택된 AI 제공자 | 1 |
| `apiKey` | string | Claude 직접 API 키 | 1 |
| `openrouterKey` | string | OpenRouter API 키 | 1 |
| `openrouterModel` | string | OpenRouter 모델명(선택) | 1 |
| `customKey` | string | 커스텀 API 키(선택) | 1 |
| `customModel` | string | 커스텀 모델명 | 1 |
| `customBaseUrl` | string | 커스텀 API Base URL | 1 |
| `docTitle` | string | 내보낼 매뉴얼 제목 | 1 |
| `audience` | string | 대상 독자(선택, 프롬프트 보강용) | 1 |

---

## 3. 상세 스키마

### 3.1 `steps` — 단계 레코드 (Step)

`steps`는 `Step` 객체의 배열입니다. 각 단계는 `background.js`의 `handleCaptureStep`에서 생성·push됩니다.

| 필드 | 타입 | NULL/기본 | 설명 |
|---|---|---|---|
| `id` | string | 필수 | 고유 ID. `Date.now() + "-" + base36(5자)` 형식 |
| `index` | number | 필수 | 1부터 시작하는 단계 순번. 삭제 시 재계산 |
| `action` | string | 필수 | 사용자 동작: `"클릭"` / `"입력"` / `"화면 캡처"`(수동 캡처) |
| `label` | string | `""` 가능 | 요소 식별 텍스트(aria-label/placeholder/title/name/innerText). 민감 필드는 `"[입력값 비공개]"` |
| `tag` | string | 필수 | 소문자 HTML 태그명 (예: `button`, `input`) |
| `selector` | string | `""` 가능 | 추정 CSS selector (id > data-testid > nth-of-type 경로) |
| `url` | string | 필수 | 동작 발생 페이지 `location.href` |
| `ts` | number | 필수 | 생성 시각 epoch ms (`Date.now()`) |
| `screenshot` | string | `""` 가능 | `data:image/jpeg;base64,...` data URL. 민감 입력/캡처 실패 시 빈 문자열 |
| `description` | string | `""` (초기) | LLM이 생성한 단계 설명. 생성 전엔 빈 값, 사용자가 직접 편집 가능 |

**예시 레코드**

```json
{
  "id": "1730000000000-a1b2c",
  "index": 3,
  "action": "클릭",
  "label": "저장",
  "tag": "button",
  "selector": "#app > div > button:nth-of-type(2)",
  "url": "https://example.com/app",
  "ts": 1730000000000,
  "screenshot": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  "description": "화면 우측 상단의 \"저장\" 버튼을 클릭하세요."
}
```

### 3.2 설정 키 (Settings)

제공자별로 키/모델이 **분리 저장**되어, 제공자를 전환해도 서로 덮어쓰지 않습니다. UI는 입력칸 하나를 공유하고 전환 시 해당 제공자 값으로 표시를 바꿉니다.

| 필드 | 타입 | 기본 | 설명 |
|---|---|---|---|
| `provider` | string | `"claude"` | `"claude"` \| `"openrouter"` \| `"custom"` |
| `apiKey` | string | `""` | Claude 직접 키 |
| `openrouterKey` | string | `""` | OpenRouter 키 |
| `openrouterModel` | string | `""` | 비우면 `anthropic/claude-sonnet-4.6` |
| `customKey` | string | `""` | 커스텀 키(선택) |
| `customModel` | string | `""` | 커스텀 모델(필수) |
| `customBaseUrl` | string | `""` | 커스텀 Base URL(필수) |
| `docTitle` | string | `""` | 비우면 내보내기 시 `"사용 매뉴얼"` |
| `audience` | string | `""` | 시스템 프롬프트에 추가되는 대상 독자 |

코드 내 키 매핑 상수:

```js
const KEY_FIELD   = { claude: "apiKey", openrouter: "openrouterKey", custom: "customKey" };
const MODEL_FIELD = { openrouter: "openrouterModel", custom: "customModel" };
```

---

## 4. 동시성 / 무결성 전략

관계형 DB의 트랜잭션이 없으므로, `steps` 배열의 read-modify-write 경쟁 조건을 **애플리케이션 레벨 직렬화 큐**로 방지합니다.

| 컨텍스트 | 메커니즘 | 목적 |
|---|---|---|
| `background.js` | `queue = queue.then(() => handle*(...))` (`CAPTURE_STEP`·`MANUAL_CAPTURE` 모두 `storeStep`으로 수렴) | 빠른 연속 클릭/캡처 시 단계 유실(race) 방지 + 캡처 간격 보장 |
| `sidepanel.js` | `updateSteps(mutator)` → `writeQueue` 체인 | 동시 3개 설명 생성의 병렬 write 직렬화 |

**`updateSteps` 패턴** (sidepanel.js):

```js
let writeQueue = Promise.resolve();
function updateSteps(mutator) {
  writeQueue = writeQueue.then(async () => {
    const { steps = [] } = await chrome.storage.local.get("steps");
    const next = mutator(steps);
    await chrome.storage.local.set({ steps: next ?? steps });
  });
  return writeQueue;
}
```

> 모든 단계 변경(설명 저장/편집/삭제/초기화)은 반드시 `updateSteps`를 거쳐 한 번에 하나씩만 storage를 갱신합니다.

---

## 5. 마이그레이션 전략

- 정식 마이그레이션 시스템(Alembic 등)은 없습니다. 스키마는 코드와 함께 진화합니다.
- 모든 읽기는 기본값 패턴(`const { steps = [] } = ...`)을 사용하므로, 키가 없는 초기 상태에서도 안전합니다.
- 신규 필드 추가 시 기존 레코드는 해당 필드가 `undefined`로 읽히므로, 렌더링/내보내기 코드에서 falsy 가드(`step.screenshot ? ... : ""`)로 호환성을 유지합니다.
- 데이터 초기화: 설정 패널의 **기록 전체 지우기**(`clearBtn`) → `updateSteps(() => [])`로 `steps`를 빈 배열로 리셋.
