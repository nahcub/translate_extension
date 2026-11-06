import { LEVELS } from "./config.js";

const levelInput = document.getElementById("level");
const levelLabel = document.getElementById("levelLabel");
const activeToggle = document.getElementById("activeToggle");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const userRow = document.getElementById("userRow");
const userEmail = document.getElementById("userEmail");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function refresh() {
  const state = await send("PT_GET_STATE");
  if (!state?.ok) {
    setStatus("상태 로드 실패", "err");
    return;
  }

  const { settings, session, lastError, signingIn } = state;
  levelInput.value = String(settings.levelIndex ?? 4);
  levelLabel.textContent = LEVELS[settings.levelIndex] || "C1";
  activeToggle.checked = Boolean(settings.active);

  if (session?.email) {
    loginBtn.classList.add("hidden");
    userRow.classList.remove("hidden");
    userEmail.textContent = session.email;
  } else {
    loginBtn.classList.remove("hidden");
    userRow.classList.add("hidden");
    userEmail.textContent = "";
  }

  loginBtn.disabled = Boolean(signingIn);
  loginBtn.textContent = signingIn ? "로그인 창 진행 중…" : "구글로 로그인하기";

  if (!session && signingIn) {
    setStatus("로그인 중…", "warn");
    hintEl.textContent = "열린 Google 로그인 창에서 계속하세요.";
    return;
  } else if (!session) {
    setStatus("로그인 필요", "warn");
  } else if (settings.active) {
    setStatus(lastError ? "오류 · 아래 확인" : "활성화됨", lastError ? "err" : "on");
  } else {
    setStatus("비활성", "");
  }

  hintEl.textContent = lastError || "";
}

levelInput.addEventListener("input", async () => {
  const levelIndex = Number(levelInput.value);
  levelLabel.textContent = LEVELS[levelIndex];
  await send("PT_SET_SETTINGS", { patch: { levelIndex } });
  await refresh();
});

activeToggle.addEventListener("change", async () => {
  const state = await send("PT_GET_STATE");
  if (activeToggle.checked && !state?.session) {
    activeToggle.checked = false;
    setStatus("먼저 구글 로그인하세요", "warn");
    return;
  }
  await send("PT_SET_SETTINGS", { patch: { active: activeToggle.checked } });
  if (activeToggle.checked) await send("PT_CLEAR_ERROR");
  await refresh();
});

loginBtn.addEventListener("click", async () => {
  if (loginBtn.disabled) return;
  loginBtn.disabled = true;
  setStatus("로그인 중…", "warn");
  const res = await send("PT_SIGN_IN");
  loginBtn.disabled = false;
  if (!res?.ok) {
    setStatus("로그인 실패", "err");
    hintEl.textContent = res?.error || "알 수 없는 오류";
    return;
  }
  await refresh();
});

logoutBtn.addEventListener("click", async () => {
  await send("PT_SET_SETTINGS", { patch: { active: false } });
  await send("PT_SIGN_OUT");
  await refresh();
});

refresh();
setInterval(refresh, 5000);
