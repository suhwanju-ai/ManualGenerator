# API 설계 문서 — Manual Capture

> **프로젝트 개요**: Manual Capture는 웹페이지에서의 사용자 상호작용(클릭·입력)을 녹화하고, 각 단계의 스크린샷을 비전 LLM에 보내 단계별 설명을 자동 생성한 뒤, 자체 완결형 HTML 매뉴얼로 내보내는 Chrome 확장 프로그램(Manifest V3)입니다. 별도의 빌드 시스템이나 백엔드 서버가 없는 순수 브라우저 확장입니다.

이 확장은 전통적인 REST 백엔드를 갖지 않습니다. 따라서 본 문서의 "API"는 두 종류를 다룹니다.

1. **외부 LLM API** — 단계 설명 생성을 위해 호출하는 3개 제공자(Claude 직접 / OpenRouter / OpenAI 호환 커스텀).
2. **내부 메시지 프로토콜** — 확장 내 3개 격리된 JS 컨텍스트(content / background / sidepanel)가 `chrome.runtime.sendMessage`로 주고받는 메시지 규약.

실용적인 사용 흐름은 → [API 사용자 가이드](api-user-guide.md), 전체 구조는 → [시스템 아키텍처](system-architecture.md)를 참고하세요.

---

## 1. 인증 방식

| 제공자 | 인증 헤더 | 키 저장 위치 | 필수 여부 |
|---|---|---|---|
| Claude 직접 | `x-api-key: <키>` | `chrome.storage.local.apiKey` | 필수 |
| OpenRouter | `Authorization: Bearer <키>` | `chrome.storage.local.openrouterKey` | 필수 |
| OpenAI 호환 커스텀 | `Authorization: Bearer <키>` | `chrome.storage.local.customKey` | **선택** (로컬 서버는 생략 가능) |

- 모든 키는 사용자의 기기 내 `chrome.storage.local`에만 저장되며 외부로 전송되지 않습니다(LLM 호출 헤더 제외).
- Claude 직접 호출은 브라우저에서의 CORS 우회를 위해 `anthropic-dangerous-direct-browser-access: true` 헤더를 추가합니다.
- 커스텀 제공자는 키가 없으면 `Authorization` 헤더 자체를 생략합니다(Ollama/LM Studio/vLLM 등 로컬 서버 대응).

---

## 2. 외부 LLM API

### 2.1 Claude 직접 — 단계 설명 생성

| 항목 | 값 |
|---|---|
| Method | `POST` |
| URL | `https://api.anthropic.com/v1/messages` |
| 모델 | `claude-sonnet-4-6` (비전 지원, 코드 상수 `MODEL`) |
| 구현 함수 | `describeViaClaude()` (`sidepanel.js`) |

**Request Headers**

```http
content-type: application/json
x-api-key: sk-ant-...
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
```

**Request Body** (JSON)

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 400,
  "system": "당신은 비개발자도 이해할 수 있는 친절한 소프트웨어 사용 매뉴얼을 작성하는 전문가입니다. 한국어로, ...",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "<base64 인코딩된 JPEG, data URL의 콤마 뒤 부분>"
          }
        },
        {
          "type": "text",
          "text": "사용자 동작: 클릭\n대상 요소: <button> \"저장\"\n페이지 URL: https://example.com/app\n이 단계의 설명을 작성하세요."
        }
      ]
    }
  ]
}
```

- 스크린샷이 없는 단계(민감 입력 등)는 `image` 블록을 생략하고 `text` 블록만 전송합니다.

**성공 응답 (200)**

```json
{
  "content": [
    { "type": "text", "text": "화면 우측 상단의 \"저장\" 버튼을 클릭하세요." }
  ]
}
```

응답 처리: `data.content`에서 `type === "text"`인 블록의 `text`를 합쳐 `.trim()`한 문자열을 단계 설명으로 사용합니다.

### 2.2 OpenAI 호환 (OpenRouter / 커스텀) — 단계 설명 생성

OpenRouter와 커스텀 제공자는 동일 코드 경로(`describeViaOpenAICompat()`)를 공유합니다.

| 항목 | OpenRouter | 커스텀 |
|---|---|---|
| Method | `POST` | `POST` |
| URL | `https://openrouter.ai/api/v1/chat/completions` | `<customBaseUrl>/chat/completions` |
| 기본 모델 | `anthropic/claude-sonnet-4.6` (사용자 변경 가능) | `customModel` (필수 입력) |
| 추가 헤더 | `X-Title: Manual Capture` | 없음 |

**Request Headers**

```http
content-type: application/json
Authorization: Bearer <키>          # 키가 있을 때만
X-Title: Manual Capture             # OpenRouter만
```

**Request Body** (JSON, OpenAI Chat Completions 규격)

```json
{
  "model": "anthropic/claude-sonnet-4.6",
  "max_tokens": 400,
  "messages": [
    { "role": "system", "content": "당신은 ... 매뉴얼 작성 전문가입니다. ..." },
    {
      "role": "user",
      "content": [
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
        { "type": "text", "text": "사용자 동작: 입력\n대상 요소: <input> \"검색어\"\n페이지 URL: ...\n이 단계의 설명을 작성하세요." }
      ]
    }
  ]
}
```

- 스크린샷은 data URL 전체를 `image_url.url`로 그대로 전달합니다(Claude 방식과 달리 base64 분리 불필요).
- 모든 비-Claude 모델은 **비전(이미지) 지원 모델**이어야 합니다.

**성공 응답 (200)**

```json
{
  "choices": [
    { "message": { "content": "화면의 검색창에 원하는 키워드를 입력하세요." } }
  ]
}
```

응답 처리: `data.choices[0].message.content`를 `.trim()`하여 사용. 값이 없으면 `"<제공자> 응답에 내용이 없습니다."` 오류를 던집니다.

---

## 3. 공통 정책

### 3.1 토큰/생성 파라미터

| 파라미터 | 값 | 비고 |
|---|---|---|
| `max_tokens` | `400` | 모든 제공자 공통 |
| 시스템 프롬프트 | 한국어 | 명령형 1~2문장, 비개발자 대상 |
| `audience` 설정 | 선택 | 입력 시 시스템 프롬프트에 `대상 독자: <값>.` 추가 |

### 3.2 동시성

| 항목 | 값 | 상수 |
|---|---|---|
| 동시 설명 생성 개수 | 3 | `GEN_CONCURRENCY` |
| 처리 방식 | 워커 풀(`worker()` × 3)이 `pending` 큐를 소진 | — |

### 3.3 재시도 정책 (`fetchWithRetry`)

| 항목 | 값 |
|---|---|
| 재시도 대상 상태 코드 | `429`, `>= 500` (5xx) |
| 재시도 대상 | 네트워크 오류(fetch reject) 포함 |
| 최대 재시도 횟수 | 3 (`MAX_RETRIES`) |
| 백오프 | 지수 백오프: `1000 * 2^(attempt-1)` ms → 1s, 2s, 4s |

### 3.4 오류 응답 처리

| 상태 | 처리 |
|---|---|
| `2xx` | 정상 — 설명 텍스트 추출 |
| `429`, `5xx` | `fetchWithRetry`가 자동 재시도 (최대 3회) |
| `4xx` (429 제외) | 재시도 없이 즉시 `Error(`API <status>: <body 앞 160자>`)` |
| 재시도 소진 | 마지막 오류를 throw → 해당 단계만 실패 처리(`failed++`), 토스트 알림 |

> 단계별 호출은 서로 독립적이므로 한 단계가 실패해도 나머지 단계 생성은 계속됩니다.

---

## 4. 내부 메시지 프로토콜 (확장 컨텍스트 간)

### 4.1 `CAPTURE_STEP` — content.js → background.js

사용자가 클릭/입력할 때 content script가 단계 메타데이터를 service worker로 전송합니다.

| 항목 | 값 |
|---|---|
| 전송 | `chrome.runtime.sendMessage({ type: "CAPTURE_STEP", data })` |
| 수신 | `background.js`의 `chrome.runtime.onMessage` 리스너 |
| 응답 | 비동기 (`return true`) |

**Request `data` 스키마**

```json
{
  "action": "클릭",                       // "클릭" | "입력"
  "label": "저장",                         // 요소 식별 텍스트 (민감 필드는 "[입력값 비공개]")
  "tag": "button",                         // 소문자 태그명
  "selector": "#app > button:nth-of-type(2)", // 추정 CSS selector
  "url": "https://example.com/app",        // location.href
  "skipScreenshot": false                  // 민감 입력일 때 true → 캡처 생략
}
```

**성공 응답**

```json
{ "ok": true, "count": 5 }
```

**기타 응답**

```json
{ "ok": false, "skipped": true }              // 녹화 중이 아님
{ "ok": false, "error": "..." }               // 처리 중 예외
```

> background는 이 메시지를 받아 (조건에 따라) `captureVisibleTab`으로 스크린샷을 찍고 `steps` 배열에 단계를 push합니다. 상세 흐름은 → [시퀀스 다이어그램](sequence-diagrams.md).

### 4.2 `MANUAL_CAPTURE` — sidepanel.js → background.js

사이드패널의 **"📷 현재 화면 캡처"** 버튼(녹화 중에만 노출)을 누르면, 클릭/입력 이벤트와 무관하게 현재 보이는 화면을 한 단계로 추가합니다. 스크롤 후 결과 화면, 로딩 완료 상태 등 자동 캡처로 잡기 어려운 화면용입니다.

| 항목 | 값 |
|---|---|
| 전송 | `chrome.runtime.sendMessage({ type: "MANUAL_CAPTURE" })` |
| 수신 | `background.js`의 `handleManualCapture()` |
| 응답 | 비동기 (`return true`) |

**처리 흐름**

1. `recording`이 아니면 `{ ok: false, skipped: true }` 반환.
2. `chrome.tabs.query({ active: true, lastFocusedWindow: true })`로 활성 탭 조회(메시지에 `sender.tab`이 없으므로 직접 질의).
3. `captureWithThrottle(tab.windowId)`로 스크린샷 캡처(`CAPTURE_STEP`과 동일한 650ms 스로틀 공유).
4. `storeStep()`으로 단계 저장: `action: "화면 캡처"`, `label`/`tag`/`selector`는 빈 문자열, `url`은 탭의 URL.

**성공 응답**

```json
{ "ok": true, "count": 6 }
```

> `CAPTURE_STEP`과 `MANUAL_CAPTURE`는 단계 저장 헬퍼 `storeStep()`과 동일한 직렬화 큐를 공유하므로 race 조건이 없습니다. `tag`가 비어 있는 단계는 설명 생성 시 `describeStep`이 "대상 요소" 줄을 생략하고 스크린샷 위주로 설명합니다.

### 4.3 상태 전파 — `chrome.storage.onChanged`

명시적 메시지 외에, 컨텍스트 간 상태 동기화는 `chrome.storage.local` 변경 이벤트로 이루어집니다.

| 변경 키 | 수신 컨텍스트 | 동작 |
|---|---|---|
| `recording` | content.js | 녹화 on/off 상태 갱신 |
| `recording` | sidepanel.js | 녹화 버튼 UI 갱신 (`refreshRecordingUI`) |
| `steps` | sidepanel.js | 단계 리스트 재렌더 (200ms 디바운스) |

---

## 5. Rate Limiting & Pagination

- **Rate limiting (송신측)**: `captureVisibleTab` 호출은 최소 650ms 간격으로 스로틀됩니다(`CAPTURE_MIN_INTERVAL_MS`). Chrome의 초당 캡처 횟수 제한 예외를 회피하기 위함입니다.
- **Rate limiting (수신측)**: LLM 제공자의 429 응답은 §3.3 지수 백오프로 대응합니다.
- **Pagination**: 해당 없음. 단계 데이터는 전량 `chrome.storage.local`에 보관되며 페이지네이션 없이 전체를 읽어 렌더링합니다.

---

## 6. 엔드포인트 요약

| # | 종류 | Method | 경로 / 메시지 | 구현 |
|---|---|---|---|---|
| 1 | 외부 | POST | `api.anthropic.com/v1/messages` | `describeViaClaude` |
| 2 | 외부 | POST | `openrouter.ai/api/v1/chat/completions` | `describeViaOpenAICompat` |
| 3 | 외부 | POST | `<customBaseUrl>/chat/completions` | `describeViaOpenAICompat` |
| 4 | 내부 | message | `CAPTURE_STEP` | `handleCaptureStep` → `storeStep` |
| 5 | 내부 | message | `MANUAL_CAPTURE` | `handleManualCapture` → `storeStep` |
| 6 | 내부 | event | `storage.onChanged(recording/steps)` | 각 컨텍스트 리스너 |
