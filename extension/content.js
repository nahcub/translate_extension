(() => {
  const ATTR = "data-pt-id";
  const DONE = "data-pt-done";
  const SELECTORS = "p, h1, h2, h3, h4, h5, h6, li, blockquote";
  const BATCH = 6;
  // First request of a scan is small so the first words show up sooner
  // (output length drives model latency). Later requests use BATCH.
  const FIRST_BATCH = 3;
  const CONCURRENCY = 3;
  // Only paragraphs on screen or within about one screen of it get requested.
  const PREFETCH_MARGIN = "100% 0px 100% 0px";
  // Coalesce bursts of DOM mutations into one scan.
  const SCAN_DEBOUNCE_MS = 150;
  // Collect paragraphs that become visible close together into one request.
  const INTERSECT_COALESCE_MS = 80;
  const OWN_NODE_SELECTOR = ".pt-gloss, .pt-highlight, .pt-banner";
  const queue = [];
  // Elements already handed to the IntersectionObserver
  let observed = new WeakSet();
  // Elements currently inside the viewport + prefetch margin
  const nearViewport = new Set();
  let io = null;
  let scanTimer = null;
  let sentFirstBatch = false;
  const inflight = new Set();
  let settings = { active: false, levelIndex: 4 };
  let signedIn = false;
  let inFlightCount = 0;
  let scanGen = 0;
  let quotaBlocked = false;
  let pauseUntil = 0;
  let pumpTimer = null;
  let observer = null;
  let idSeq = 0;
  let banner = null;

  function uid() {
    idSeq += 1;
    return `pt-${Date.now()}-${idSeq}`;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 8) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  }

  function isSiteChrome(el) {
    if (el.closest("nav, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], [role='menu']")) {
      return true;
    }
    const header = el.closest("header");
    return Boolean(header && !header.closest("article"));
  }

  function isLinkListItem(el) {
    if (el.tagName !== "LI") return false;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length < 80) return true;
    const link = el.querySelector(":scope > a");
    if (!link) return false;
    const linkText = (link.innerText || "").replace(/\s+/g, " ").trim();
    return linkText.length > 0 && linkText.length / text.length > 0.85;
  }

  function collectTargets() {
    return [...document.querySelectorAll(SELECTORS)].filter((el) => {
      if (el.closest(".pt-gloss, .pt-banner")) return false;
      if (observed.has(el) || el.hasAttribute(DONE) || inflight.has(el)) return false;
      if (el.closest("[contenteditable='true'], button, textarea, select")) return false;
      if (isSiteChrome(el)) return false;
      if (el.querySelector(SELECTORS)) return false;
      if (isLinkListItem(el)) return false;
      const text = (el.innerText || "").trim();
      if (text.length < 12) return false;
      return true;
    });
  }

  function priority(el) {
    const rect = el.getBoundingClientRect();
    const inView = rect.bottom > 0 && rect.top < window.innerHeight + 160;
    const inArticle = Boolean(el.closest("article, main, [role='main']"));
    const list = el.tagName === "LI" ? 1 : 0;
    return (inView ? 0 : 4) + (inArticle ? 0 : 2) + list;
  }

  function showBanner(text) {
    if (!banner) {
      banner = document.createElement("p");
      banner.className = "pt-banner";
      document.documentElement.appendChild(banner);
    }
    banner.textContent = text;
  }

  function hideBanner() {
    banner?.remove();
    banner = null;
  }

  function schedulePump(ms) {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump();
    }, ms);
  }

  function ensureIO() {
    if (io) return io;
    io = new IntersectionObserver(onIntersect, { rootMargin: PREFETCH_MARGIN });
    return io;
  }

  function onIntersect(entries) {
    let added = false;
    for (const entry of entries) {
      const el = entry.target;
      if (entry.isIntersecting) {
        nearViewport.add(el);
        if (el.hasAttribute(DONE) || inflight.has(el) || queue.includes(el)) continue;
        if (!isVisible(el)) continue;
        if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, uid());
        queue.push(el);
        added = true;
      } else {
        nearViewport.delete(el);
        // Scrolled far away before its turn: drop it, it re-queues on return.
        const i = queue.indexOf(el);
        if (i >= 0) queue.splice(i, 1);
      }
    }
    if (added) {
      queue.sort((a, b) => priority(a) - priority(b));
      // Short wait so paragraphs entering one by one while scrolling share a
      // request instead of each paying for the fixed prompt. The prefetch
      // margin is a full screen, so the wait is not visible.
      schedulePump(INTERSECT_COALESCE_MS);
    }
  }

  // Finds new candidate paragraphs and hands them to the IntersectionObserver.
  // Requests happen only from onIntersect, i.e. for paragraphs near the screen.
  function scanTargets() {
    if (!settings.active || !signedIn || quotaBlocked) return;
    const observer = ensureIO();
    for (const el of collectTargets()) {
      observed.add(el);
      observer.observe(el);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanTargets();
    }, SCAN_DEBOUNCE_MS);
  }

  // Requeue paragraphs that are near the screen but not done (after an error
  // pause, quota reset, or re-scan).
  function requeueNearViewport() {
    for (const el of nearViewport) {
      if (!document.contains(el)) {
        nearViewport.delete(el);
        continue;
      }
      if (el.hasAttribute(DONE) || inflight.has(el) || queue.includes(el)) continue;
      if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, uid());
      queue.push(el);
    }
    queue.sort((a, b) => priority(a) - priority(b));
    pump();
  }

  // A mutation is "ours" when it adds/removes our gloss/highlight/banner
  // elements and no other elements. Text nodes are ignored when deciding,
  // because highlighting splits text nodes around each <mark>.
  function isOwnMutation(m) {
    if (m.target?.nodeType === Node.ELEMENT_NODE && m.target.closest?.(OWN_NODE_SELECTOR)) {
      return true;
    }
    const elements = [...m.addedNodes, ...m.removedNodes].filter(
      (n) => n.nodeType === Node.ELEMENT_NODE,
    );
    return elements.length > 0 && elements.every((n) => n.matches?.(OWN_NODE_SELECTOR));
  }

  function termsForBatch(results, batch) {
    const list = Array.isArray(results) ? results : [];
    const anyId = list.some((r) => batch.some((el) => el.getAttribute(ATTR) === r?.id));
    return batch.map((el, index) => {
      const id = el.getAttribute(ATTR);
      const hit = anyId ? list.find((r) => r?.id === id) : list[index];
      return hit?.terms || [];
    });
  }

  function takeBatch() {
    const size = sentFirstBatch ? BATCH : FIRST_BATCH;
    const batch = [];
    while (batch.length < size && queue.length) {
      const el = queue.shift();
      if (!el || inflight.has(el) || !document.contains(el) || el.hasAttribute(DONE)) continue;
      batch.push(el);
    }
    return batch;
  }

  function pump() {
    if (!settings.active || !signedIn || quotaBlocked) return;
    if (Date.now() < pauseUntil) {
      schedulePump(pauseUntil - Date.now());
      return;
    }
    while (inFlightCount < CONCURRENCY) {
      const batch = takeBatch();
      if (!batch.length) return;
      sentFirstBatch = true;
      inFlightCount += 1;
      const gen = scanGen;
      for (const el of batch) {
        inflight.add(el);
        el.classList.add("pt-processing");
      }
      runBatch(batch, gen);
    }
  }

  async function runBatch(batch, gen) {
    let retryBatch = false;
    try {
      const paragraphs = batch.map((el) => ({
        id: el.getAttribute(ATTR),
        text: (el.innerText || "").trim(),
      }));
      const res = await chrome.runtime.sendMessage({
        type: "PT_ANNOTATE",
        paragraphs,
      });
      if (gen !== scanGen || !settings.active) return;
      if (!res?.ok) {
        if (res?.code === "QUOTA_EXCEEDED") {
          quotaBlocked = true;
          queue.length = 0;
          showBanner(res.error || "오늘 사용량을 모두 사용했습니다");
        } else if (res?.code === "NOT_SIGNED_IN") {
          signedIn = false;
          queue.length = 0;
          showBanner("로그인이 필요합니다");
        } else {
          retryBatch = true;
          pauseUntil = Date.now() + 4000;
          showBanner(res?.error || "단어를 가져오지 못했습니다");
          console.warn("[PT] annotate failed", res?.error);
        }
        return;
      }
      hideBanner();
      const termLists = termsForBatch(res.data?.results, batch);
      batch.forEach((el, index) => {
        if (!document.contains(el)) return;
        applyAnnotation(el, termLists[index]);
        el.setAttribute(DONE, "1");
      });
    } catch (err) {
      if (gen !== scanGen || !settings.active) return;
      retryBatch = true;
      pauseUntil = Date.now() + 4000;
      showBanner("단어를 가져오지 못했습니다");
      console.warn("[PT] pump error", err);
    } finally {
      for (const el of batch) {
        el.classList.remove("pt-processing");
        inflight.delete(el);
      }
      inFlightCount -= 1;
      if (gen === scanGen && retryBatch) {
        for (const el of batch) {
          if (
            document.contains(el) &&
            nearViewport.has(el) &&
            !el.hasAttribute(DONE) &&
            !queue.includes(el)
          ) {
            queue.unshift(el);
          }
        }
      }
      if (gen === scanGen && queue.length) pump();
    }
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightTextNode(textNode, terms) {
    const text = textNode.nodeValue;
    if (!text || !terms.length) return;

    const sorted = [...terms].sort((a, b) => b.surface.length - a.surface.length);
    let pattern;
    try {
      pattern = new RegExp(`(${sorted.map((t) => escapeRegExp(t.surface)).join("|")})`, "gi");
    } catch {
      return;
    }

    if (!pattern.test(text)) return;
    pattern.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const mark = document.createElement("mark");
      mark.className = "pt-highlight";
      mark.textContent = match[0];
      frag.appendChild(mark);
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    textNode.parentNode.replaceChild(frag, textNode);
  }

  function walkHighlight(root, terms) {
    if (!terms.length) return;
    const surfaces = new Set(terms.map((t) => t.surface.toLowerCase()));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(".pt-gloss, .pt-highlight, script, style")) {
          return NodeFilter.FILTER_REJECT;
        }
        const lower = node.nodeValue.toLowerCase();
        for (const s of surfaces) {
          if (lower.includes(s)) return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => highlightTextNode(n, terms));
  }

  function renderGloss(el, terms) {
    const prev = el.nextElementSibling;
    if (prev?.classList?.contains("pt-gloss")) prev.remove();
    if (!terms.length) return;

    const gloss = document.createElement("div");
    gloss.className = "pt-gloss";
    gloss.setAttribute("aria-label", "word glosses");
    terms.forEach((t) => {
      const item = document.createElement("span");
      item.className = "pt-gloss-item";
      item.textContent = `${t.surface} - ${t.meaning}`;
      gloss.appendChild(item);
    });
    el.insertAdjacentElement("afterend", gloss);
  }

  function applyAnnotation(el, terms) {
    const unique = [];
    const seen = new Set();
    for (const t of terms) {
      const key = `${t.surface.toLowerCase()}|${t.meaning}`;
      if (!t.surface || seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
    }
    walkHighlight(el, unique);
    renderGloss(el, unique);
  }

  function findBlockFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.anchorNode;
    if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return node?.closest?.(SELECTORS) || null;
  }

  async function addWord(selection) {
    if (!settings.active || !signedIn) return;
    const block = findBlockFromSelection();
    if (!block) return;
    if (!block.hasAttribute(ATTR)) block.setAttribute(ATTR, uid());

    const res = await chrome.runtime.sendMessage({
      type: "PT_DEFINE",
      selection,
      text: (block.innerText || "").trim(),
    });
    if (!res?.ok) {
      console.warn("[PT] define failed", res?.error);
      return;
    }

    const term = {
      surface: res.data.surface || selection,
      meaning: res.data.meaning,
    };

    const existing = [];
    const gloss = block.nextElementSibling;
    if (gloss?.classList?.contains("pt-gloss")) {
      gloss.querySelectorAll(".pt-gloss-item").forEach((item) => {
        const [surface, ...rest] = item.textContent.split(" - ");
        existing.push({ surface: surface.trim(), meaning: rest.join(" - ").trim() });
      });
    }
    const merged = [...existing.filter((t) => t.surface.toLowerCase() !== term.surface.toLowerCase()), term];
    walkHighlight(block, [term]);
    renderGloss(block, merged);
    block.setAttribute(DONE, "1");
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (!settings.active) return;
      // Our own gloss/highlight insertions should not trigger a page rescan.
      if (mutations.every(isOwnMutation)) return;
      scheduleScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    // No scroll listener: the IntersectionObserver reports paragraphs as they
    // come near the screen.
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    resetIO();
    queue.length = 0;
    hideBanner();
  }

  function resetIO() {
    io?.disconnect();
    io = null;
    observed = new WeakSet();
    nearViewport.clear();
  }

  function clearAnnotations() {
    document.querySelectorAll(".pt-gloss").forEach((el) => el.remove());
    document.querySelectorAll(".pt-highlight").forEach((mark) => {
      const text = document.createTextNode(mark.textContent || "");
      mark.replaceWith(text);
    });
    document.querySelectorAll(`[${DONE}]`).forEach((el) => el.removeAttribute(DONE));
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "PT_PING") {
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "PT_SETTINGS") {
      const wasActive = settings.active;
      const wasSignedIn = signedIn;
      const prevLevel = settings.levelIndex;
      settings = { ...settings, ...message.settings };
      signedIn = Boolean(message.signedIn);
      if (settings.active && signedIn) {
        const needRescan =
          !wasActive ||
          !wasSignedIn ||
          prevLevel !== settings.levelIndex;
        if (needRescan) {
          quotaBlocked = false;
          pauseUntil = 0;
          scanGen += 1;
          queue.length = 0;
          sentFirstBatch = false;
          clearAnnotations();
          resetIO();
        }
        startObserver();
        scanTargets();
        requeueNearViewport();
      } else {
        stopObserver();
        if (wasActive) clearAnnotations();
      }
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "PT_ADD_WORD") {
      addWord(message.selection).then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  chrome.runtime.sendMessage({ type: "PT_GET_STATE" }).then((state) => {
    if (!state?.ok) return;
    settings = { ...settings, ...state.settings };
    signedIn = Boolean(state.session);
    if (settings.active && signedIn) {
      clearAnnotations();
      startObserver();
      scanTargets();
    }
  });
})();
