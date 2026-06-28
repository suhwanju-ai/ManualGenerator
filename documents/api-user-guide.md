# API 사용자 가이드 — Manual Capture

이 문서는 Manual Capture가 호출하는 LLM API를 직접 다루거나, 확장을 확장(extend)/디버깅하려는 개발자를 위한 실용 가이드입니다. 정식 명세는 → [API 설계 문서](api-design.md), 전체 구조는 → [시스템 아키텍처](system-architecture.md)를 참고하세요.

---

## 1. 시작하기

### 1.1 제공자 선택

설정 패널의 **AI 제공자** 드롭다운에서 하나를 고릅니다.

| 제공자 | 키 필요 | 모델 지정 | Base URL |
|---|---|---|---|
| Claude (Anthropic 직접) | 필수 (`sk-ant-...`) | 고정 `claude-sonnet-4-6` | 불필요 |
| OpenRouter | 필수 (`sk-or-...`) | 선택 (기본 `anthropic/claude-sonnet-4.6`) | 불필요 |
| OpenAI 호환 커스텀 | 선택 | **필수** | **필수** |

> 커스텀/OpenRouter 모델은 반드시 **비전(이미지) 지원 모델**이어야 합니다. 스크린샷을 함께 보내기 때문입니다.

### 1.2 첫 호출 흐름 (확장 내부)

1. **녹화 시작** → 웹앱 클릭/입력 → 단계 자동 수집
2. **녹화 정지** → **설명 생성** 클릭
3. 미설명 단계(`description`이 빈 값)만 골라 동시 3개씩 LLM 호출
4. 응답 텍스트를 각 단계의 `description`에 저장 → 리스트 갱신

---

## 2. 직접 호출 예제

아래는 확장 외부에서 같은 요청을 재현하는 예제입니다(디버깅/검증용).

### 2.1 Claude 직접 — curl

```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-dangerous-direct-browser-access: true" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 400,
    "system": "당신은 비개발자도 이해할 수 있는 친절한 소프트웨어 사용 매뉴얼을 작성하는 전문가입니다. 한국어로, 명령형 한 문장으로 설명하세요.",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "<BASE64>" } },
        { "type": "text", "text": "사용자 동작: 클릭\n대상 요소: <button> \"저장\"\n페이지 URL: https://example.com\n이 단계의 설명을 작성하세요." }
      ]
    }]
  }'
```

### 2.2 OpenAI 호환 — Python `requests`

```python
import requests

resp = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={
        "content-type": "application/json",
        "Authorization": f"Bearer {OPENROUTER_KEY}",
        "X-Title": "Manual Capture",
    },
    json={
        "model": "anthropic/claude-sonnet-4.6",
        "max_tokens": 400,
        "messages": [
            {"role": "system", "content": "당신은 ... 매뉴얼 작성 전문가입니다."},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<BASE64>"}},
                {"type": "text", "text": "사용자 동작: 입력\n대상 요소: <input> \"검색어\"\n페이지 URL: ...\n이 단계의 설명을 작성하세요."},
            ]},
        ],
    },
)
print(resp.json()["choices"][0]["message"]["content"])
```

### 2.3 로컬 서버 (Ollama) — JavaScript `fetch`

```js
// 커스텀 제공자: Base URL = http://localhost:11434/v1, 키 없음 → Authorization 생략
const res = await fetch("http://localhost:11434/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "llama3.2-vision",
    max_tokens: 400,
    messages: [
      { role: "system", content: "당신은 ... 매뉴얼 작성 전문가입니다." },
      { role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } },
        { type: "text", text: "사용자 동작: 클릭\n..." },
      ] },
    ],
  }),
});
const data = await res.json();
console.log(data.choices[0].message.content);
```

---

## 3. 주요 사용 시나리오

### 시나리오 A — Claude로 매뉴얼 생성 (기본)
1. 설정 → 제공자 `Claude`, API 키 입력 → 녹화 → 정지 → 설명 생성 → HTML 내보내기.

### 시나리오 B — OpenRouter로 다른 모델 사용
1. 제공자 `OpenRouter`, 키 입력, 모델란에 예: `openai/gpt-4o` 입력(비전 지원).
2. 비워두면 기본 `anthropic/claude-sonnet-4.6` 사용.

### 시나리오 C — 사내/로컬 모델 (비용 0, 오프라인)
1. 제공자 `OpenAI 호환 커스텀`, Base URL `http://localhost:11434/v1`, 모델 `llama3.2-vision`, 키 비움.

### 시나리오 D — 일부 단계만 재생성
1. 잘못된 설명 단계의 텍스트를 직접 비우거나, 단계를 **삭제** 후 다시 **설명 생성**.
2. `description`이 비어있는 단계만 재호출되므로 비용 낭비가 없습니다.

### 시나리오 E — 민감 화면 포함 녹화
1. 비밀번호·이메일 등 민감 입력은 자동으로 값이 기록되지 않고 스크린샷도 생략됩니다.
2. 해당 단계는 텍스트 메타데이터만으로 설명이 생성됩니다.

---

## 4. 에러 코드 및 대처

| 상황 | 표시 메시지 | 원인 | 대처 |
|---|---|---|---|
| 키 미입력 | `설정에서 ... 키를 먼저 입력하세요.` | 필수 키/URL/모델 누락 | 설정 패널 자동 오픈 → 입력 |
| `API 401` | `API 401: ...` | 잘못된 키 | 키 재확인 |
| `API 400` | `API 400: ...` | 모델명 오류, 비전 미지원 등 | 모델명/비전 지원 확인 |
| `API 429` | (자동 재시도) | rate limit | 자동 백오프, 반복 시 잠시 대기 |
| `API 5xx` | (자동 재시도) | 제공자 과부하 | 자동 백오프 최대 3회 |
| `... 응답에 내용이 없습니다.` | 빈 응답 | 모델이 텍스트 미반환 | 다른 모델/프롬프트 |
| 캡처 실패(경고) | 콘솔 `captureVisibleTab 실패` | `chrome://` 등 캡처 불가 페이지 | 일반 웹페이지에서 녹화 |

---

## 5. FAQ / 트러블슈팅

**Q. 설명 생성이 일부 단계만 됐어요.**
실패한 단계는 토스트로 알림이 뜨고 `description`이 비어 남습니다. **설명 생성**을 다시 누르면 빈 단계만 재시도합니다.

**Q. 스크린샷이 비어 있어요.**
민감 입력(비밀번호/이메일/전화/숫자/hidden, 또는 이름에 pass·token·card 등 포함)은 의도적으로 캡처를 생략합니다. 또한 `captureVisibleTab`은 **보이는 영역만** 찍습니다.

**Q. 페이지 이동 후 엉뚱한 화면이 찍혀요.**
클릭 즉시 네비게이션이 일어나면 캡처가 다음 화면을 잡을 수 있습니다. 클릭은 `mousedown` 시점에 기록되지만 캡처는 90ms 뒤이므로 빠른 이동에서는 드물게 어긋날 수 있습니다.

**Q. 로컬 모델인데 인증 오류가 나요.**
커스텀 제공자에서 키를 비우면 `Authorization` 헤더가 생략됩니다. 키를 입력하면 `Bearer`로 전송되니, 키를 요구하지 않는 서버라면 비워두세요.

**Q. 단계 데이터를 다른 곳에 쓰고 싶어요.**
현재는 HTML 내보내기만 지원합니다. 단계는 `chrome.storage.local.steps`에 JSON으로 보관되므로 → [DB 설계 문서](database-design.md)의 스키마를 참고해 추출할 수 있습니다.
