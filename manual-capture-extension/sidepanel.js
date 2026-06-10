// sidepanel.js
// 모델: 비전 지원 + 비용/품질 균형. 필요시 claude-opus-4-8 등으로 교체 가능.
const MODEL = "claude-sonnet-4-6";
const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-4.6"; // 비전 지원 필수
const GEN_CONCURRENCY = 3;      // 동시 설명 생성 개수
const MAX_RETRIES = 3;          // API rate limit/overloaded 재시도 횟수
const RENDER_DEBOUNCE_MS = 200; // 녹화 중 리스트 재렌더 디바운스

// steps에 대한 read-modify-write 직렬화 (병렬 생성 시 race 방지)
let writeQueue = Promise.resolve();
function updateSteps(mutator) {
  writeQueue = writeQueue.then(async () => {
    const { steps = [] } = await chrome.storage.local.get("steps");
    const next = mutator(steps);
    await chrome.storage.local.set({ steps: next ?? steps });
  });
  return writeQueue;
}

const $ = (id) => document.getElementById(id);
const recBtn = $("recBtn"),
  dot = $("dot"),
  statusText = $("statusText"),
  genBtn = $("genBtn"),
  exportBtn = $("exportBtn"),
  clearBtn = $("clearBtn"),
  stepsEl = $("steps"),
  emptyEl = $("empty"),
  toastEl = $("toast"),
  progress = $("progress"),
  progressBar = $("progressBar"),
  apiKeyEl = $("apiKey"),
  providerEl = $("provider"),
  apiKeyLabel = $("apiKeyLabel"),
  baseUrlWrap = $("baseUrlWrap"),
  baseUrlEl = $("baseUrl"),
  orModelWrap = $("orModelWrap"),
  orModelLabel = $("orModelLabel"),
  orModelEl = $("orModel"),
  orModelHint = $("orModelHint"),
  docTitleEl = $("docTitle"),
  audienceEl = $("audience");

// ---- 설정 로드/저장 ----
// API 키·모델은 제공자별로 분리 저장한다(전환해도 서로 지워지지 않음).
// 입력칸은 하나를 공유하고 제공자 전환 시 해당 값으로 표시를 바꾼다.
const PROVIDER_UI = {
  claude: { keyLabel: "Claude API 키", keyPh: "sk-ant-..." },
  openrouter: {
    keyLabel: "OpenRouter API 키",
    keyPh: "sk-or-...",
    modelLabel: "OpenRouter 모델",
    modelPh: "anthropic/claude-sonnet-4.6",
    modelHint: "비워두면 기본 모델을 사용합니다. 비전(이미지) 지원 모델이어야 합니다.",
  },
  custom: {
    keyLabel: "API 키 (서버가 요구하지 않으면 비워두기)",
    keyPh: "sk-... 또는 빈칸",
    modelLabel: "모델",
    modelPh: "예: gpt-4o, llama3.2-vision",
    modelHint: "필수 입력. 스크린샷을 보내므로 비전(이미지) 지원 모델이어야 합니다.",
  },
};
const KEY_FIELD = { claude: "apiKey", openrouter: "openrouterKey", custom: "customKey" };
const MODEL_FIELD = { openrouter: "openrouterModel", custom: "customModel" };

function syncProviderUI() {
  const p = providerEl.value;
  const ui = PROVIDER_UI[p];
  apiKeyLabel.textContent = ui.keyLabel;
  apiKeyEl.placeholder = ui.keyPh;
  baseUrlWrap.style.display = p === "custom" ? "" : "none";
  orModelWrap.style.display = ui.modelLabel ? "" : "none";
  if (ui.modelLabel) {
    orModelLabel.textContent = ui.modelLabel;
    orModelEl.placeholder = ui.modelPh;
    orModelHint.textContent = ui.modelHint;
  }
}

// 공유 입력칸에 현재 제공자의 저장값을 채운다
function fillProviderFields(s) {
  const p = providerEl.value;
  apiKeyEl.value = s[KEY_FIELD[p]] || "";
  orModelEl.value = (MODEL_FIELD[p] && s[MODEL_FIELD[p]]) || "";
  baseUrlEl.value = s.customBaseUrl || "";
}

async function loadSettings() {
  const s = await chrome.storage.local.get([
    "provider", "apiKey", "openrouterKey", "openrouterModel",
    "customKey", "customModel", "customBaseUrl", "docTitle", "audience",
  ]);
  providerEl.value = s.provider || "claude";
  fillProviderFields(s);
  docTitleEl.value = s.docTitle || "";
  audienceEl.value = s.audience || "";
  syncProviderUI();
}

function saveSettings() {
  const p = providerEl.value;
  const patch = {
    provider: p,
    customBaseUrl: baseUrlEl.value.trim(),
    docTitle: docTitleEl.value.trim(),
    audience: audienceEl.value.trim(),
  };
  patch[KEY_FIELD[p]] = apiKeyEl.value.trim();
  if (MODEL_FIELD[p]) patch[MODEL_FIELD[p]] = orModelEl.value.trim();
  chrome.storage.local.set(patch);
}
[apiKeyEl, orModelEl, baseUrlEl, docTitleEl, audienceEl].forEach((el) =>
  el.addEventListener("change", saveSettings)
);
providerEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ provider: providerEl.value });
  const s = await chrome.storage.local.get([
    "apiKey", "openrouterKey", "openrouterModel",
    "customKey", "customModel", "customBaseUrl",
  ]);
  fillProviderFields(s);
  syncProviderUI();
});

// ---- 녹화 토글 ----
async function refreshRecordingUI() {
  const { recording } = await chrome.storage.local.get("recording");
  recBtn.classList.toggle("recording", !!recording);
  recBtn.textContent = recording ? "■ 녹화 정지" : "● 녹화 시작";
  dot.classList.toggle("live", !!recording);
  statusText.textContent = recording ? "녹화 중 — 앱을 클릭하세요" : "대기 중";
}
recBtn.addEventListener("click", async () => {
  const { recording } = await chrome.storage.local.get("recording");
  await chrome.storage.local.set({ recording: !recording });
  refreshRecordingUI();
});

// ---- 단계 렌더링 ----
async function renderSteps() {
  const { steps = [] } = await chrome.storage.local.get("steps");
  emptyEl.style.display = steps.length ? "none" : "block";
  stepsEl.innerHTML = "";
  steps.forEach((step) => {
    const card = document.createElement("div");
    card.className = "step";
    const img = step.screenshot
      ? `<img src="${step.screenshot}" alt="단계 ${step.index}" />`
      : "";
    card.innerHTML = `
      ${img}
      <div class="step-body">
        <div class="step-head">
          <span class="step-num">${step.index}</span>
          <span class="step-action">${escapeHtml(step.action)}${
      step.label ? ` · "${escapeHtml(step.label)}"` : ""
    }</span>
        </div>
        ${
          step.description
            ? `<textarea class="step-desc" data-id="${step.id}">${escapeHtml(
                step.description
              )}</textarea>`
            : `<div class="step-pending">설명 대기 중 — '설명 생성'을 누르세요</div>`
        }
        <button class="del" data-del="${step.id}">삭제</button>
      </div>`;
    stepsEl.appendChild(card);
  });

  // 설명 직접 편집 저장
  stepsEl.querySelectorAll(".step-desc").forEach((ta) => {
    ta.addEventListener("change", () =>
      updateSteps((steps) => {
        const t = steps.find((s) => s.id === ta.dataset.id);
        if (t) t.description = ta.value;
        return steps;
      })
    );
  });
  // 단계 삭제
  stepsEl.querySelectorAll("[data-del]").forEach((b) => {
    b.addEventListener("click", async () => {
      await updateSteps((steps) =>
        steps
          .filter((s) => s.id !== b.dataset.del)
          .map((s, i) => ({ ...s, index: i + 1 }))
      );
      renderSteps();
    });
  });
}

// ---- 설명 생성 (Claude 직접 / OpenRouter) ----
async function describeStep(step, settings) {
  const sys =
    "당신은 비개발자도 이해할 수 있는 친절한 소프트웨어 사용 매뉴얼을 작성하는 전문가입니다. " +
    "한국어로, 사용자가 이 화면에서 무엇을 해야 하는지 명령형 한 문장(필요하면 짧게 두 문장)으로 설명하세요. " +
    "버튼·메뉴 이름은 따옴표로 감싸고, 군더더기 없이 작성합니다. 설명 외 다른 말은 붙이지 마세요." +
    (settings.audience ? ` 대상 독자: ${settings.audience}.` : "");
  const ctx =
    `사용자 동작: ${step.action}\n` +
    `대상 요소: <${step.tag}> "${step.label || ""}"\n` +
    `페이지 URL: ${step.url}\n` +
    `이 단계의 설명을 작성하세요.`;

  if (settings.provider === "openrouter") {
    return describeViaOpenAICompat(step, sys, ctx, {
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: settings.openrouterKey,
      model: settings.openrouterModel || OPENROUTER_DEFAULT_MODEL,
      name: "OpenRouter",
      extraHeaders: { "X-Title": "Manual Capture" },
    });
  }
  if (settings.provider === "custom") {
    const base = (settings.customBaseUrl || "").replace(/\/+$/, "");
    return describeViaOpenAICompat(step, sys, ctx, {
      url: base + "/chat/completions",
      key: settings.customKey,
      model: settings.customModel,
      name: "Custom API",
    });
  }
  return describeViaClaude(step, settings, sys, ctx);
}

async function describeViaClaude(step, settings, sys, ctx) {
  const base64 = (step.screenshot || "").split(",")[1];
  const content = [];
  if (base64)
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: base64 },
    });
  content.push({ type: "text", text: ctx });

  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: sys,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// OpenAI 호환 chat/completions (OpenRouter, Ollama, LM Studio, vLLM 등).
// 이미지는 data URL을 image_url로 전달. key가 없으면 Authorization 헤더 생략(로컬 서버 대응).
async function describeViaOpenAICompat(step, sys, ctx, api) {
  const content = [];
  if (step.screenshot)
    content.push({ type: "image_url", image_url: { url: step.screenshot } });
  content.push({ type: "text", text: ctx });

  const headers = { "content-type": "application/json", ...(api.extraHeaders || {}) };
  if (api.key) headers.authorization = `Bearer ${api.key}`;

  const res = await fetchWithRetry(api.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: api.model,
      max_tokens: 400,
      messages: [
        { role: "system", content: sys },
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${api.name} ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${api.name} 응답에 내용이 없습니다.`);
  return text.trim();
}

// 429(rate limit)/529(overloaded)/5xx 는 지수 백오프로 재시도
async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`API ${res.status} (재시도 ${attempt}/${MAX_RETRIES})`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e; // 네트워크 오류도 재시도
    }
  }
  throw lastErr;
}

genBtn.addEventListener("click", async () => {
  const settings = await chrome.storage.local.get([
    "provider", "apiKey", "openrouterKey", "openrouterModel",
    "customKey", "customModel", "customBaseUrl", "audience",
  ]);
  // 제공자별 필수 설정 검증. 커스텀 API는 키가 선택(로컬 서버)이고 주소·모델이 필수.
  let missing = "";
  if (settings.provider === "openrouter") {
    if (!settings.openrouterKey) missing = "OpenRouter API 키를";
  } else if (settings.provider === "custom") {
    if (!settings.customBaseUrl) missing = "API Base URL을";
    else if (!settings.customModel) missing = "모델 이름을";
  } else {
    if (!settings.apiKey) missing = "Claude API 키를";
  }
  if (missing) {
    toast(`설정에서 ${missing} 먼저 입력하세요.`, "err");
    $("settings").open = true;
    return;
  }
  const { steps = [] } = await chrome.storage.local.get("steps");
  const todo = steps.filter((s) => !s.description);
  if (!todo.length) {
    toast("생성할 단계가 없습니다.", "ok");
    return;
  }
  genBtn.disabled = true;
  exportBtn.disabled = true;
  progress.style.display = "block";
  progressBar.style.width = "0%";

  let done = 0;
  let failed = 0;

  // 단계별 호출은 서로 독립적이므로 동시 GEN_CONCURRENCY개 제한 병렬 처리.
  // storage 갱신은 updateSteps 큐로 직렬화되어 race 없음.
  const pending = [...todo];
  async function worker() {
    while (pending.length) {
      const step = pending.shift();
      try {
        const desc = await describeStep(step, settings);
        await updateSteps((cur) => {
          const t = cur.find((s) => s.id === step.id);
          if (t) t.description = desc;
          return cur;
        });
      } catch (e) {
        failed++;
        toast(`단계 ${step.index} 생성 실패: ${e.message}`, "err");
      }
      done++;
      progressBar.style.width = `${(done / todo.length) * 100}%`;
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(GEN_CONCURRENCY, todo.length) }, worker)
    );
    await renderSteps();
    if (!failed) toast(`${done}개 단계 설명을 생성했습니다.`, "ok");
  } finally {
    genBtn.disabled = false;
    exportBtn.disabled = false;
    setTimeout(() => (progress.style.display = "none"), 600);
  }
});

// ---- HTML 내보내기 (자체 완결형, 이미지 임베드) ----
exportBtn.addEventListener("click", async () => {
  const { steps = [] } = await chrome.storage.local.get("steps");
  if (!steps.length) {
    toast("내보낼 단계가 없습니다.", "err");
    return;
  }
  const settings = await chrome.storage.local.get(["docTitle"]);
  const title = settings.docTitle || "사용 매뉴얼";
  const html = buildManualHtml(title, steps);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = title.replace(/[\\/:*?"<>|]/g, "_") + ".html";
  a.click();
  URL.revokeObjectURL(url);
  toast("HTML 매뉴얼을 내보냈습니다.", "ok");
});

function buildManualHtml(title, steps) {
  const items = steps
    .map(
      (s) => `
    <section class="step">
      <div class="num">${s.index}</div>
      <div class="content">
        <p class="desc">${escapeHtml(s.description || s.action + (s.label ? ` — "${s.label}"` : ""))}</p>
        ${s.screenshot ? `<img src="${s.screenshot}" alt="단계 ${s.index}" />` : ""}
        <p class="meta">${s.action}${s.label ? ` · "${escapeHtml(s.label)}"` : ""}</p>
      </div>
    </section>`
    )
    .join("");
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#1b1d22;max-width:820px;margin:0 auto;padding:48px 24px;line-height:1.6;}
  h1{font-size:26px;letter-spacing:-0.02em;border-bottom:3px solid #e5484d;padding-bottom:12px;}
  .gen{color:#6b7280;font-size:13px;margin-bottom:32px;}
  .step{display:flex;gap:16px;margin:0 0 28px;}
  .num{flex:0 0 32px;height:32px;background:#e5484d;color:#fff;font-weight:700;border-radius:8px;display:flex;align-items:center;justify-content:center;}
  .content{flex:1;min-width:0;}
  .desc{font-size:15.5px;font-weight:600;margin:4px 0 10px;}
  .content img{max-width:100%;border:1px solid #e6e8ec;border-radius:8px;display:block;}
  .meta{color:#9aa0a6;font-size:12px;margin-top:6px;}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p class="gen">총 ${steps.length}단계 · 생성일 ${new Date().toLocaleDateString("ko-KR")}</p>
${items}
</body></html>`;
}

// ---- 유틸 ----
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function toast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = "toast " + (kind || "");
  if (kind === "ok") setTimeout(() => (toastEl.textContent = ""), 3000);
}

clearBtn.addEventListener("click", async () => {
  if (!confirm("기록된 모든 단계를 지웁니다. 계속할까요?")) return;
  await updateSteps(() => []);
  renderSteps();
  toast("기록을 지웠습니다.", "ok");
});

// 녹화 중 다른 탭에서 단계가 쌓이면 실시간 반영 (스크린샷 포함 전체 재렌더이므로 디바운스)
let renderTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.steps) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderSteps, RENDER_DEBOUNCE_MS);
  }
  if (changes.recording) refreshRecordingUI();
});

// 초기화
loadSettings();
refreshRecordingUI();
renderSteps();
