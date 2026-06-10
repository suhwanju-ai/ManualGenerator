// content.js — 모든 페이지에 주입.
// 녹화 중일 때 사용자의 클릭/입력을 감지해 (1) 요소를 빨간 박스로 강조하고
// (2) selector·텍스트·URL 등 컨텍스트를 background로 보낸다. 스크린샷은 background가 찍는다.

(() => {
  const MARK = "data-mcap-overlay";
  let recording = false;

  chrome.storage.local.get("recording", (r) => {
    recording = !!r.recording;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.recording) {
      recording = !!changes.recording.newValue;
    }
  });

  // 안정적인 CSS selector 추정 (id > data-testid > nth-of-type 경로)
  function cssSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.nodeName.toLowerCase();
      const dt = node.getAttribute && node.getAttribute("data-testid");
      if (dt) {
        parts.unshift(`${sel}[data-testid="${dt}"]`);
        break;
      }
      const parent = node.parentNode;
      if (parent && parent.children) {
        const sib = Array.from(parent.children).filter(
          (c) => c.nodeName === node.nodeName
        );
        if (sib.length > 1) sel += `:nth-of-type(${sib.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(" > ");
  }

  // 값 자체를 기록하면 안 되는 민감 입력 타입
  const SENSITIVE_INPUT_TYPES = new Set([
    "password", "email", "tel", "number", "hidden",
  ]);
  const SENSITIVE_NAME_HINT = /pass|pwd|secret|token|card|cvv|ssn|주민|비밀/i;

  function isSensitiveInput(el) {
    if (el.tagName !== "INPUT") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (SENSITIVE_INPUT_TYPES.has(type)) return true;
    const hint = `${el.name || ""} ${el.id || ""} ${el.autocomplete || ""}`;
    return SENSITIVE_NAME_HINT.test(hint);
  }

  function labelFor(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    const ph = el.getAttribute && el.getAttribute("placeholder");
    const title = el.getAttribute && el.getAttribute("title");
    // 입력 요소는 사용자가 친 값(el.value) 대신 필드를 식별하는 메타데이터만 기록.
    // 민감 필드는 어떤 경우에도 값이 저장/전송되지 않도록 한다.
    const isFormField = ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    if (isFormField) {
      if (isSensitiveInput(el)) {
        return aria || ph || title || "[입력값 비공개]";
      }
      return aria || ph || title || (el.name || "");
    }
    const text = (el.innerText || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);
    return aria || text || ph || title || "";
  }

  function highlight(el) {
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const box = document.createElement("div");
    box.setAttribute(MARK, "1");
    Object.assign(box.style, {
      position: "fixed",
      left: rect.left - 4 + "px",
      top: rect.top - 4 + "px",
      width: rect.width + 8 + "px",
      height: rect.height + 8 + "px",
      border: "3px solid #e5484d",
      borderRadius: "6px",
      pointerEvents: "none",
      zIndex: "2147483647",
      transition: "opacity 0.25s",
    });
    document.documentElement.appendChild(box);
    setTimeout(() => {
      box.style.opacity = "0";
      setTimeout(() => box.remove(), 300);
    }, 700);
  }

  const HIGHLIGHT_PAINT_DELAY_MS = 90; // 하이라이트가 그려진 뒤 캡처 요청

  function record(action, el) {
    if (!recording || !el || el.nodeType !== 1) return;
    if (el.getAttribute && el.getAttribute(MARK)) return; // 우리 오버레이는 무시
    highlight(el);
    const data = {
      action,
      label: labelFor(el),
      tag: el.nodeName.toLowerCase(),
      selector: cssSelector(el),
      url: location.href,
      // 민감 필드 입력 단계는 화면에 평문이 노출될 수 있어 스크린샷 생략
      skipScreenshot: action === "입력" && isSensitiveInput(el),
    };
    setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: "CAPTURE_STEP", data });
      } catch (_) {}
    }, HIGHLIGHT_PAINT_DELAY_MS);
  }

  // 클릭은 mousedown(캡처 단계)에서 잡아 페이지 이동 전 상태를 기록
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      record("클릭", e.target);
    },
    true
  );

  // 입력 값 변경
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target;
      if (t && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName)) {
        record("입력", t);
      }
    },
    true
  );
})();
