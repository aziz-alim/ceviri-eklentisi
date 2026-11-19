/* Çeviri Eklentisi — sayfa üstü hover çeviri (Google Translate tarzı)
   Herhangi bir web sayfasında kelimenin üzerine gelince anlam baloncuğu gösterir.
   Sağ tık / seçim gerekmez. Local sözlük anında; sözlükte yoksa Ollama (local LLM) devreye girer. */
(() => {
  if (window.__krHover) return;          // çift enjeksiyon koruması
  window.__krHover = true;

  const WORD_CHAR = /[A-Za-zçÇğĞıİöÖşŞüÜ'-]/;
  const LETTER = /[A-Za-zçÇğĞıİöÖşŞüÜ]/;
  const SHOW_DELAY = 500;                // imleç kelimede 0,5 sn kalınca tetiklen
  const HIDE_DELAY = 220;                // balona geçişe pay bırak

  let enabled = true;
  let settings = { domain: "devops", ollamaUrl: "http://localhost:11434", model: "llama3.1", hoverEnabled: true };
  let siteRules = {};                    // hostname -> true (açık); yoksa kapalı (beyaz liste)
  let siteDomains = {};                  // hostname -> "devops" | "software" | "general"
  const HOST = location.hostname;
  let customGlossary = {};
  let userDict = {};
  let meaningsDict = {};
  let explainDict = {};                  // Ollama'nın ürettiği Türkçe açıklamalar (kalıcı)
  let sentenceDict = {};                 // cümle -> Türkçe çevirisi (kalıcı, yan panelle ortak)
  let ctxDict = {};                      // cümle -> {tr, w: {kelime: {a: bu cümledeki anlam, k: çevirideki karşılık, l: kök, n: not}}}
  let contextLog = {};                   // kelime -> [{s: cümle, h: site, t: zaman}] (en fazla 5/kelime)
  let ctxDirty = false, ctxFlushTimer = null, ctxQueue = [];
  let known = new Set(), learning = new Set();

  const llmCache = new Map();            // oturum içi: kelime -> çeviri | null
  const llmPending = new Set();
  const llmFailed = new Set();           // zaman aşımı / geçersiz yanıt (Ollama açık ama çeviri gelmedi)
  let llmDown = false;                   // Ollama erişilemiyorsa spinner gösterme
  let llmDownAt = 0;                     // 60 sn sonra otomatik tekrar dene

  let tip = null, showTimer = null, hideTimer = null, ctx = null;

  init();
  async function init() {
    try {
      const st = await chrome.storage.local.get(
        ["settings", "siteRules", "siteDomains", "customGlossary", "userDict", "meaningsDict",
         "explainDict", "sentenceDict", "ctxDict", "contextLog", "knownWords", "learningWords"]);
      if (st.settings) settings = { ...settings, ...st.settings };
      siteRules = st.siteRules || {};
      siteDomains = st.siteDomains || {};
      enabled = isEnabled();
      customGlossary = st.customGlossary || {};
      userDict = st.userDict || {};
      meaningsDict = st.meaningsDict || {};
      explainDict = st.explainDict || {};
      sentenceDict = st.sentenceDict || {};
      ctxDict = st.ctxDict || {};
      contextLog = st.contextLog || {};
      known = new Set(st.knownWords || []);
      learning = new Set(st.learningWords || []);
    } catch (e) { return; }              // eklenti yeniden yüklendiyse sessiz çık

    chrome.storage.onChanged.addListener((chg, area) => {
      if (area !== "local") return;
      if (chg.settings) {
        settings = { ...settings, ...(chg.settings.newValue || {}) };
        enabled = isEnabled();
        if (!enabled) hideTip(true);
        refreshHlState();
        setupPrefetch();
      }
      if (chg.siteRules) {
        siteRules = chg.siteRules.newValue || {};
        enabled = isEnabled();
        if (!enabled) hideTip(true);
        refreshHlState();
        setupPrefetch();
      }
      if (chg.siteDomains) siteDomains = chg.siteDomains.newValue || {};
      if (chg.customGlossary) customGlossary = chg.customGlossary.newValue || {};
      if (chg.userDict) userDict = chg.userDict.newValue || {};
      if (chg.meaningsDict) meaningsDict = chg.meaningsDict.newValue || {};
      if (chg.explainDict) explainDict = chg.explainDict.newValue || {};
      if (chg.sentenceDict) sentenceDict = chg.sentenceDict.newValue || {};
      if (chg.ctxDict) { ctxDict = chg.ctxDict.newValue || {}; scheduleWidget(); }
      if (chg.contextLog && !ctxDirty) contextLog = chg.contextLog.newValue || {};
      if (chg.knownWords) { known = new Set(chg.knownWords.newValue || []); scheduleHlScan(250); }
      if (chg.learningWords) { learning = new Set(chg.learningWords.newValue || []); scheduleHlScan(250); }
    });

    document.addEventListener("mousemove", onMouseMove, { passive: true });
    // balonun kendi butonlarına basarken kapatma: mousedown, click'ten ÖNCE gelir
    // ve ctx'i silerse butonlar "çalışmıyor" gibi görünür
    document.addEventListener("mousedown", (e) => {
      if (tip && tip.contains(e.target)) return;
      hideTip(true);
    }, { passive: true });
    document.addEventListener("scroll", () => hideTip(true), { passive: true, capture: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(true); });
    document.addEventListener("mouseup", onSelectEnd);          // sürükle-seç → çeviri

    refreshHlState();
    setupPrefetch();
    new MutationObserver((muts) => {
      for (const m of muts) if (m.addedNodes.length) { scheduleBlockScan(1500); return; }
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (bgPending.size) try { chrome.runtime.sendMessage({ type: "krh-bg-cancel" }, () => void chrome.runtime.lastError); } catch (e) {}
      } else {
        visibleBlocks.forEach((el) => enqueueBlock(el));
      }
    });
    if (HL_SUPPORTED) {
      // sonsuz kaydırma vb. yeni içerik geldiğinde renkleri tazele (debounce'lu)
      new MutationObserver((muts) => {
        for (const m of muts) if (m.addedNodes.length) { scheduleHlScan(1500); return; }
      }).observe(document.body, { childList: true, subtree: true });
    }
    setTimeout(detectDomainSuggestion, 1500);   // sayfa otursun, sonra tara
  }

  /* ---- otomatik alan tespiti: sayfa DevOps/Yazılım ağırlıklıysa popup'ta öneri çıkar ---- */
  function detectDomainSuggestion() {
    try {
      if (!enabled || siteDomains[HOST]) return;   // kullanıcı bu site için zaten seçmiş
      const text = (document.body?.innerText || "").slice(0, 20000).toLowerCase();
      if (text.length < 500) return;
      const HINTS = {
        devops: ["kubernetes", "docker", "container", "deployment", "pipeline", "ci/cd",
          "devops", "terraform", "helm", "nginx", "cluster", "pod", "ingress", "rollback",
          "jenkins", "ansible", "microservice", "observability", "infrastructure", "sre"],
        software: ["api", "sdk", "compile", "runtime", "framework", "refactor", "dependency",
          "repository", "async", "debug", "library", "backend", "frontend", "algorithm"]
      };
      const scores = {};
      for (const [dom, words] of Object.entries(HINTS)) {
        let sc = 0;
        for (const kw of words) {
          const m = text.match(new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"));
          if (m) sc += Math.min(m.length, 10);
        }
        scores[dom] = sc;
      }
      const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      if (!best || best[1] < 6 || best[0] === curDomain()) return;
      chrome.storage.local.set({
        domainSuggestion: { host: HOST, domain: best[0], ts: Date.now() }
      }).catch(() => {});
    } catch (e) {}
  }

  /* ---- bilinen/öğrenilen kelimeleri renklendir (Custom Highlight API — DOM'a dokunmaz) ---- */
  const HL_SUPPORTED = typeof CSS !== "undefined" && !!CSS.highlights;
  let hlOn = false, hlTimer = null;
  const HL_WORD = /[A-Za-zçÇğĞıİöÖşŞüÜ][A-Za-zçÇğĞıİöÖşŞüÜ'-]{1,39}/g;
  const HL_MAX = 6000;                   // sayfa başına renk sınırı (performans)

  /* site bazlı alan: bu site (veya üst alanı) için seçim varsa o, yoksa genel varsayılan */
  function curDomain() {
    let h = HOST;
    while (h) {
      if (siteDomains[h]) return siteDomains[h];
      const i = h.indexOf(".");
      if (i < 0) break;
      h = h.slice(i + 1);
    }
    return settings.domain || "general";
  }

  function refreshHlState() {
    hlOn = HL_SUPPORTED && settings.highlightEnabled !== false && isEnabled();
    scheduleHlScan(400);
  }

  function scheduleHlScan(delay) {
    if (!HL_SUPPORTED) return;
    clearTimeout(hlTimer);
    hlTimer = setTimeout(scanHighlights, delay);
  }

  function scanHighlights() {
    CSS.highlights.delete("kr-known");
    CSS.highlights.delete("kr-learning");
    if (!hlOn || !document.body || (!known.size && !learning.size)) return;

    const knownRanges = [], learningRanges = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest("script,style,noscript,input,textarea,select,option,[contenteditable=''],[contenteditable='true'],#krh-tip"))
          return NodeFilter.FILTER_REJECT;
        return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let node, count = 0;
    while ((node = walker.nextNode()) && count < HL_MAX) {
      const text = node.data;
      HL_WORD.lastIndex = 0;
      let m;
      while ((m = HL_WORD.exec(text)) && count < HL_MAX) {
        const w = m[0].replace(/^[-']+|[-']+$/g, "").toLowerCase();
        const isKnown = known.has(w), isLearning = !isKnown && learning.has(w);
        if (!isKnown && !isLearning) continue;
        try {
          const r = new Range();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          (isKnown ? knownRanges : learningRanges).push(r);
          count++;
        } catch (e) { /* aralık kurulamadı: atla */ }
      }
    }
    if (knownRanges.length) CSS.highlights.set("kr-known", new Highlight(...knownRanges));
    if (learningRanges.length) CSS.highlights.set("kr-learning", new Highlight(...learningRanges));
  }

  /* BEYAZ LİSTE: hover varsayılan KAPALI; yalnızca açık işaretlenen sitelerde çalışır.
     Alt alan adları üst kuralı miras alır: example.com açıksa www.example.com da açıktır.
     Genel anahtar (hoverEnabled) kapalıysa hiçbir sitede çalışmaz. */
  function isEnabled() {
    if (settings.hoverEnabled === false) return false;
    let h = HOST;
    while (h) {
      if (siteRules[h] === true) return true;
      const i = h.indexOf(".");
      if (i < 0) break;
      h = h.slice(i + 1);
    }
    return false;
  }

  /* ---- imleç altındaki kelimeyi bul ---- */
  function wordAtPoint(x, y) {
    let node, offset;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer; offset = r.startOffset;
    } else if (document.caretPositionFromPoint) {   // Firefox yedeği
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode; offset = p.offset;
    } else return null;

    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const parent = node.parentElement;
    if (!parent) return null;
    if (parent.closest("input, textarea, select, option, script, style, noscript, [contenteditable=''], [contenteditable='true'], #krh-tip")) return null;

    const text = node.data;
    if (!text || !text.trim()) return null;

    // caret karakterler arasında durabilir: önce sağdaki, yoksa soldaki karakter
    let i = offset;
    if (i >= text.length || !WORD_CHAR.test(text[i])) {
      if (i > 0 && WORD_CHAR.test(text[i - 1])) i = i - 1;
      else return null;
    }
    let start = i, end = i;
    while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
    while (end < text.length - 1 && WORD_CHAR.test(text[end + 1])) end++;

    const raw = text.slice(start, end + 1);
    const word = raw.replace(/^[-']+|[-']+$/g, "");
    if (word.length < 2 || word.length > 40 || !LETTER.test(word)) return null;

    // kelimenin ekrandaki konumu (balon buraya yapışır)
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end + 1);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    range.detach();
    // caretRangeFromPoint boşlukta en yakın metne yapışır: imleç kelimenin kutusunda değilse balon açma
    const PAD = 2;
    if (x < rect.left - PAD || x > rect.right + PAD || y < rect.top - PAD || y > rect.bottom + PAD) return null;

    // ikili kalıp (phrasal verb) — önce "prev + kelime", sonra "kelime + next"
    let phrase = null;
    const prevM = text.slice(Math.max(0, start - 40), start)
      .match(/([A-Za-zçÇğĞıİöÖşŞüÜ]+)\s+$/);
    const nextM = text.slice(end + 1, end + 40)
      .match(/^\s+([A-Za-zçÇğĞıİöÖşŞüÜ]+)/);
    const pairs = [];
    if (prevM) pairs.push((prevM[1] + " " + word).toLowerCase());
    if (nextM) pairs.push((word + " " + nextM[1]).toLowerCase());
    for (const pair of pairs) {
      const tr = PHRASES[curDomain()]?.[pair] || PHRASES.software?.[pair] || PHRASES.general?.[pair];
      if (tr) { phrase = { pair, tr }; break; }
    }

    return { word, rect, sentence: sentenceFor(node, start, end), phrase };
  }

  /* cümle, mümkünse bağlantı/kod gibi satır içi öğelerle bölünmemiş paragraf metninden alınır
     (ön çeviri de aynı anahtarı üretir) */
  function sentenceFor(node, start, end) {
    const block = node.parentElement && node.parentElement.closest(BLOCK_SEL);
    if (block) {
      const full = block.textContent;
      if (full.length <= 5000) {
        let off = 0, n;
        const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        while ((n = tw.nextNode()) && n !== node) off += n.data.length;
        if (n === node) return sentenceAround(full, off + start, off + end);
      }
    }
    return sentenceAround(node.data, start, end);
  }

  function sentenceAround(text, start, end) {
    let s = start, e = end;
    while (s > 0 && !".!?…\n".includes(text[s - 1])) s--;
    while (e < text.length && !".!?…\n".includes(text[e])) e++;
    return text.slice(s, e + 1).replace(/\s+/g, " ").trim().slice(0, 300);
  }

  /* ---- köke indirgeme: running→run, containers→container, batteries→battery ---- */
  function stemVariants(w) {
    const out = [];
    const add = (s) => { if (s && s.length >= 2 && s !== w && !out.includes(s)) out.push(s); };
    add(w.replace(/'s$/, ""));
    if (/ies$/.test(w)) add(w.slice(0, -3) + "y");                          // batteries→battery
    if (/(?:ing|ed)$/.test(w)) {
      const suf = w.endsWith("ing") ? 3 : 2;
      let stem = w.slice(0, -suf);
      if (/([bcdfghjklmnpqrstvwxz])\1$/.test(stem)) stem = stem.slice(0, -1); // running→runn→run
      add(stem);
      add(stem + "e");                                                       // making→mak→make
    }
    if (/es$/.test(w)) add(w.slice(0, -2));                                  // boxes→box
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));                 // containers→container
    if (/(?:er|est)$/.test(w)) add(w.replace(/(?:er|est)$/, ""));            // faster→fast
    if (/ly$/.test(w)) add(w.slice(0, -2));                                  // quickly→quick
    return out;
  }

  function lookupDict(w) {
    if (userDict[w] || DICTIONARY[w]) return userDict[w] || DICTIONARY[w];
    for (const s of stemVariants(w)) {
      const hit = userDict[s] || DICTIONARY[s];
      if (hit) return hit;
    }
    return null;
  }

  /* alan sözlüğü: önce kelimenin kendisi, sonra kökleri (postmortems → postmortem) */
  function glossOf(w) {
    for (const k of [w, ...stemVariants(w)]) {
      const g = GLOSSARY[curDomain()]?.[k] || GLOSSARY.software?.[k] || customGlossary?.[k];
      if (g) return g;
    }
    return null;
  }

  /* ---- anlam çözümleme (wordui.js ile aynı öncelik sırası) ---- */
  function analyze(word) {
    const w = word.toLowerCase();
    const gloss = glossOf(w);
    const cached = llmCache.get(w);      // {t, other, note} | null | undefined
    const base = lookupDict(w) || (cached && cached.t) || null;
    return { w, gloss, base };
  }

  /* ---- mouse akışı ---- */
  function onMouseMove(e) {
    if (!enabled) return;
    if (wHost && e.target === wHost) { scheduleHide(); return; }   // köşe rozetinin üstü
    if (tip && tip.contains(e.target)) {           // balonun üstündeyiz: kapatma
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      return;
    }
    // metin seçimi aktifken kelime hover'ı devreye girmesin
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    clearTimeout(showTimer);
    const x = e.clientX, y = e.clientY;
    showTimer = setTimeout(() => process(x, y), SHOW_DELAY);
  }

  /* ---- sürükleyerek seçilen metni çevir ---- */
  function onSelectEnd(e) {
    if (!enabled) return;
    if (tip && tip.contains(e.target)) return;
    if (wHost && e.target === wHost) return;
    setTimeout(() => {                             // seçim nesnesi otursun
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 3 || text.length > 600) return;
      const anchor = sel.anchorNode && sel.anchorNode.parentElement;
      if (anchor && anchor.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], #krh-tip")) return;
      let rect;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (err) { return; }
      if (!rect || (!rect.width && !rect.height)) return;
      ctx = { sel: true, text, w: "", word: "", rect, sentence: text };
      renderTip();
      placeTip(rect);
      ensureTip().classList.add("on");
    }, 10);
  }

  function process(x, y) {
    const hit = wordAtPoint(x, y);
    if (!hit) { scheduleHide(); return; }
    if (ctx && ctx.w === hit.word.toLowerCase()) return;   // aynı kelime: dokunma
    ctx = { ...hit, w: hit.word.toLowerCase() };
    logContext(ctx);
    renderTip();
    placeTip(hit.rect);
    ensureTip().classList.add("on");
  }

  /* ---- bağlam geçmişi: kelime hangi cümlede/sitede görüldü ----
     Kelime başına en fazla 5 kayıt; yazma işlemi 3 sn'de bir toplu yapılır. */
  function logContext(c) {
    if (!c.sentence || c.sentence.length < 12) return;
    const arr = contextLog[c.w] || (contextLog[c.w] = []);
    if (arr.some((x) => x.s === c.sentence)) return;       // aynı cümle tekrar sayılmaz
    const entry = { s: c.sentence.slice(0, 200), h: HOST, t: Date.now() };
    arr.unshift(entry);
    if (arr.length > 5) arr.length = 5;
    // kalıcı yazım background'da (tek yazma noktası); sınırlar orada uygulanır
    ctxQueue.push({ op: "ctxAdd", w: c.w, entry });
    ctxDirty = true;
    clearTimeout(ctxFlushTimer);
    ctxFlushTimer = setTimeout(() => {
      ctxDirty = false;
      const ops = ctxQueue; ctxQueue = [];
      KRStore.mutate(ops);
    }, 3000);
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideTip(true), HIDE_DELAY);
  }
  function hideTip(clear) {
    clearTimeout(showTimer);
    if (tip) tip.classList.remove("on");
    if (clear) ctx = null;
  }

  /* ---- balon DOM ---- */
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = "krh-tip";
    tip.innerHTML =
      '<div class="krh-pillrow">' +
        '<span class="krh-pill"></span>' +
        '<span class="krh-pill krh-pill2 krh-off"></span>' +
        '<span class="krh-badge krh-off"></span>' +
        '<span class="krh-seen krh-off" title="Bu kelimeyle kaç kez karşılaştın"></span>' +
      "</div>" +
      '<div class="krh-main"></div>' +
      '<div class="krh-alt"></div>' +
      '<div class="krh-note krh-off"></div>' +
      '<div class="krh-sent krh-off"></div>' +
      '<div class="krh-btns">' +
        '<button data-s="known" title="✓ Biliyorum">✓</button>' +
        '<button data-s="learning" title="📖 Öğreniyorum">📖</button>' +
        '<button data-a="retr" title="🔄 Yeniden çevir (Ollama)">🔄</button>' +
        '<button data-a="speak" title="🔊 Telaffuz">🔊</button>' +
        '<button data-a="concept" title="📓 Kavram olarak Obsidian\'a kaydet">📓</button>' +
      "</div>";
    (document.body || document.documentElement).appendChild(tip);

    tip.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    tip.addEventListener("mouseleave", scheduleHide);
    tip.querySelectorAll("button[data-s]").forEach((b) => b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!ctx) return;
      const w = ctx.w;
      const cur = known.has(w) ? "known" : learning.has(w) ? "learning" : null;
      const next = cur === b.dataset.s ? null : b.dataset.s;
      known.delete(w); learning.delete(w);
      if (next === "known") known.add(w);
      if (next === "learning") learning.add(w);
      updateTipBtns();
      await KRStore.setState(w, next);
    }));
    tip.querySelector('[data-a="retr"]').addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await retranslate();
    });
    tip.querySelector('[data-a="speak"]').addEventListener("click", (ev) => {
      ev.stopPropagation();
      speakWord();
    });
    tip.querySelector('[data-a="concept"]').addEventListener("click", (ev) => {
      ev.stopPropagation();
      saveConcept();
    });
    return tip;
  }

  /* 🔊 kelimeyi sesli oku (tamamen local — tarayıcı TTS motoru) */
  /* 🔊 kelimeyi sesli oku (tamamen local — tarayıcı TTS motoru)
     Sesler async yüklenir: önce ısıt, sonra açıkça İngilizce bir ses seç —
     yoksa sistem Türkçe motoruna düşer ve ses "bozuk" çıkar. */
  let enVoice = null;
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const vs = speechSynthesis.getVoices();
    if (!vs.length) return;
    enVoice =
      vs.find((v) => /en[-_]US/i.test(v.lang) && /google/i.test(v.name)) ||   // Google US English (en temiz)
      vs.find((v) => /en[-_]US/i.test(v.lang) && !/compact/i.test(v.name)) ||
      vs.find((v) => /^en/i.test(v.lang) && /google|samantha|zira|aria/i.test(v.name)) ||
      vs.find((v) => /^en/i.test(v.lang)) || null;
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;   // sesler sonra gelirse yakala
  }

  function speakWord() {
    if (!ctx || !("speechSynthesis" in window)) return;
    const text = ctx.sel ? ctx.text : ctx.word;   // seçim modunda cümleyi oku
    if (!text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      if (enVoice) u.voice = enVoice;
      u.rate = 0.9;
      u.pitch = 1;
      u.volume = 1;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* 📓 kavram: balondaki kelimeyi ya da kısa seçimi (en fazla 6 kelime) Obsidian'a not olarak kaydet.
     Ollama açılımı/Türkçesini/açıklamayı doldurur; not background'da obsidian:// ile açılır. */
  const conceptBusy = new Set();
  function conceptTerm() {
    if (!ctx) return "";
    const t = (ctx.sel ? ctx.text : ctx.word || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 80 || t.split(" ").length > 6) return "";
    return t;
  }
  function setConceptBtn(icon, title) {
    const b = tip && tip.querySelector('[data-a="concept"]');
    if (!b) return;
    b.textContent = icon;
    b.title = title || "📓 Kavram olarak Obsidian'a kaydet";
  }
  function refreshConceptBtn() {
    const b = tip && tip.querySelector('[data-a="concept"]');
    if (!b) return;
    const term = conceptTerm();
    b.classList.toggle("krh-off", !term);
    if (conceptBusy.has(term.toLowerCase())) setConceptBtn("⏳", "Kavram notu hazırlanıyor…");
    else setConceptBtn("📓");
  }
  function saveConcept() {
    const term = conceptTerm();
    if (!term) return;
    const key = term.toLowerCase();
    if (conceptBusy.has(key)) return;
    conceptBusy.add(key);
    setConceptBtn("⏳", "Kavram notu hazırlanıyor… (Ollama)");
    const sentence = ctx.sel ? "" : (ctx.sentence || "");
    try {
      chrome.runtime.sendMessage({
        type: "krh-concept", term, sentence,
        url: location.href, title: document.title,
        domainLabel: DOMAIN_LABELS[curDomain()] || "genel"
      }, (resp) => {
        conceptBusy.delete(key);
        if (chrome.runtime.lastError || !resp || resp.error) {
          setConceptBtn("⚠️", "Kaydedilemedi: " + ((resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "yanıt yok"));
          return;
        }
        if (conceptTerm().toLowerCase() !== key) return;   // balon başka kelimeye geçti
        setConceptBtn("✅", resp.mode === "append"
          ? "Zaten vardı: \"Gördüğüm yerler\" bölümüne eklendi (" + resp.file + ")"
          : "Obsidian'da açıldı: " + resp.file + (resp.llm ? "" : " (Ollama yok, alanlar boş)"));
      });
    } catch (e) { conceptBusy.delete(key); setConceptBtn("⚠️", "Kaydedilemedi"); }
  }

  /* 🔄 baştan çevirt: seçim modunda cümleleri, kelime modunda kelime kaydını sil ve yeniden sor */
  async function retranslate() {
    if (!ctx) return;
    if (ctx.sel) {
      if (sentPending.has(ctx.text)) return;
      sentFailed.delete(ctx.text);
      const keys = [ctx.text, ...splitSentences(ctx.text)];   // parça kayıtlarını da tazele
      keys.forEach((k) => delete sentenceDict[k]);
      await KRStore.mutate(keys.map((key) => ({ op: "dictDel", store: "sentenceDict", key })));
      llmDown = false;
      llmDownAt = 0;
      renderTip();
      return;
    }
    const w = ctx.w;
    if (llmPending.has(w)) return;
    llmCache.delete(w);
    llmFailed.delete(w);
    delete userDict[w];
    delete meaningsDict[w];
    delete explainDict[w];
    await KRStore.deleteWord(w);
    if (ctx.sentence && ctxDict[ctx.sentence]) {          // bu cümlenin bağlamlı analizi de baştan
      ctxAsked.delete(ctx.sentence);
      delete ctxDict[ctx.sentence];
      await KRStore.mutate([{ op: "dictDel", store: "ctxDict", key: ctx.sentence }]);
    }
    llmDown = false;                    // elle yenileme: "kapalı" bayrağını yok say
    llmDownAt = 0;
    renderTip();                        // kayıt silindi → spinner + yeni istek tetiklenir
  }

  function renderTip() {
    if (!ctx) return;
    const t = ensureTip();
    const pill = t.querySelector(".krh-pill");
    const pill2 = t.querySelector(".krh-pill2");
    const badge = t.querySelector(".krh-badge");
    const main = t.querySelector(".krh-main");
    const alt = t.querySelector(".krh-alt");
    const note = t.querySelector(".krh-note");
    const sent = t.querySelector(".krh-sent");
    const seen = t.querySelector(".krh-seen");
    const btns = t.querySelector(".krh-btns");
    alt.innerHTML = "";
    note.classList.add("krh-off");
    note.textContent = "";
    sent.classList.add("krh-off");
    refreshConceptBtn();

    /* ---- seçim modu: sürüklenen metnin tek çevirisi ---- */
    if (ctx.sel) {
      pill.textContent = "🌐 seçili metin";
      pill2.classList.add("krh-off");
      badge.classList.add("krh-off");
      seen.classList.add("krh-off");
      btns.classList.remove("krh-off");
      // seçimde sadece 🔄 yeniden çevir + 🔊 oku görünür; durum butonları gizlenir
      t.querySelectorAll("button[data-s]").forEach((b) => b.classList.add("krh-off"));
      const tr = sentenceDict[ctx.text];
      if (tr) main.textContent = tr;
      else if (llmDown) main.textContent = "(çeviri için Ollama çalışıyor olmalı)";
      else if (sentFailed.has(ctx.text)) main.textContent = "(çeviri alınamadı — 🔄 ile tekrar dene)";
      else { main.textContent = "⏳ çevriliyor… (Ollama — local)"; requestSentence(ctx.text); }
      return;
    }
    btns.classList.remove("krh-off");
    t.querySelectorAll("button[data-s]").forEach((b) => b.classList.remove("krh-off"));

    const { w, gloss, base } = analyze(ctx.word);
    const cached = llmCache.get(w);      // {t, other, note} | null | undefined
    let mainTxt = "";

    if (ctx.phrase) {
      pill.textContent = ctx.phrase.pair;
      pill2.classList.remove("krh-off");
      pill2.textContent = ctx.word;
      mainTxt = "💡 " + ctx.phrase.tr;
      if (base) addAlt(alt, base);
    } else {
      pill.textContent = ctx.word;
      pill2.classList.add("krh-off");
      const cw = ctxWord(ctx.sentence, w);           // bu cümledeki anlam (varsa)
      // cümle analizi sorulup bu kelime yine de gelmediyse eski kelime çevirisine düş (döngü olmasın)
      const ctxOk = ctxEligible(ctx.sentence) &&
        !(!cw && ctxWasAsked(ctx.sentence, w) && !ctxPending.has(ctx.sentence));
      if (!gloss && !cw && ctxOk) requestAnalyze(ctx.sentence, w);   // cümle bir kez analiz edilir
      const ctxBusy = ctxOk && ctxIsPending(ctx.sentence);
      if (ctxBusy) promoteIfQueued(ctx.sentence);
      if (gloss) {
        const domainMeaning = gloss[curDomain()] || gloss.devops || gloss.software ||
          Object.values(gloss).find((v) => typeof v === "string");
        mainTxt = "✅ " + domainMeaning;
        if (gloss.general) addAlt(alt, "genel: " + gloss.general);
      } else if (cw) {
        mainTxt = "🎯 " + cw.a;
        if (base && base.toLowerCase() !== cw.a.toLowerCase()) addAlt(alt, "sözlük: " + base);
      } else if (base) {
        mainTxt = base;                                // bağlamlı anlam gelince güncellenir
      } else if (ctxBusy) {
        mainTxt = "⏳ çevriliyor… (Ollama — local)";
      } else if (ctxOk && !llmDown) {
        mainTxt = "⏳ çevriliyor… (Ollama — local)";
      } else if (llmPending.has(w)) {
        mainTxt = "⏳ çevriliyor… (Ollama — local)";
      } else if (llmFailed.has(w)) {
        mainTxt = "(çeviri alınamadı — 🔄 ile tekrar dene)";
      } else if (llmDown || cached === null) {
        mainTxt = "(yerleşik sözlükte yok)";
      } else {
        mainTxt = "⏳ çevriliyor… (Ollama — local)";
        requestLlm(ctx.word, ctx.sentence);
      }
      // diğer anlamlar: LLM şemasından, yoksa yerleşik/kayıtlı listelerden (en fazla 2)
      const arr = (cached && cached.other && cached.other.length)
        ? cached.other
        : (MEANINGS[w] || meaningsDict[w] || []);
      const skip = new Set([(base || "").toLowerCase(), cw ? cw.a.toLowerCase() : ""]);
      arr.filter((m) => m && !skip.has(m.toLowerCase())).slice(0, 2)
        .forEach((m) => addAlt(alt, "• " + m));
      // Türkçe açıklama: önce bu cümleye özel not, yoksa LLM şeması / kalıcı depo
      const noteTxt = (cw && cw.n) || (cached && cached.note) || explainDict[w] || "";
      if (noteTxt) {
        note.textContent = "💬 " + noteTxt;
        note.classList.remove("krh-off");
      }
      // cümlenin çevirisi; kelimenin karşılığı vurgulu
      const ce = ctxDict[ctx.sentence];
      if (ce && ce.tr) {
        fillSentence(sent, ce.tr, cw && cw.k);
        sent.classList.remove("krh-off");
      } else if (ctxBusy && (gloss || base)) {
        sent.textContent = "⏳ cümledeki anlamı çözülüyor…";
        sent.classList.remove("krh-off");
      }
    }

    // 📌 kaçıncı karşılaşma rozeti
    const seenCount = (contextLog[w] || []).length;
    seen.classList.toggle("krh-off", seenCount < 2);
    if (seenCount >= 2) seen.textContent = "📌 " + seenCount + ". görüş";

    badge.classList.toggle("krh-off", !gloss);
    if (gloss) badge.textContent = (DOMAIN_LABELS[curDomain()] || "domain") + " terimi";
    main.textContent = mainTxt;
    updateTipBtns();
  }

  /* ---- cümle/seçim çevirisi: background üzerinden, sentenceDict'e kalıcı yazar ----
     Paragraf seçilirse cümlelere bölünüp TEK istekte çevrilir; her cümle ayrı
     önbelleğe alınır — sonra o cümle tek başına sorulursa anında gelir. */
  const sentPending = new Set();
  const sentFailed = new Set();          // bu oturumda çevrilemeyen seçimler (sonsuz istek döngüsü olmasın)

  function splitSentences(text) {
    return text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  }

  function requestSentence(text) {
    if (sentPending.has(text) || llmDown) return;
    sentPending.add(text);
    const parts = splitSentences(text);
    const terms = termsIn(text);
    const payload = parts.length > 1
      ? { type: "krh-sentence-batch", sentences: parts, whole: text, terms }
      : { type: "krh-sentence", sentence: text, terms };
    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        sentPending.delete(text);
        if (chrome.runtime.lastError || !resp || resp.down || (!resp.t && !resp.arr)) {
          if (resp && resp.down) { llmDown = true; llmDownAt = Date.now(); }
          else sentFailed.add(text);                    // zaman aşımı / geçersiz yanıt: 🔄 ile tekrar
          if (ctx && ctx.sentence === text) renderTip();
          return;
        }
        if (resp.arr && resp.arr.length === parts.length) {
          parts.forEach((s, i) => { if (resp.arr[i]) sentenceDict[s] = resp.arr[i]; });
          sentenceDict[text] = resp.arr.filter(Boolean).join(" ");   // paragraf bütünü
        } else if (resp.t) {
          sentenceDict[text] = resp.t;
        }
        // kalıcı kayıt background'da yapıldı; burada yalnız bellekteki kopya güncel
        if (ctx && ctx.sentence === text) { renderTip(); placeTip(ctx.rect); }
      });
    } catch (e) {
      sentPending.delete(text);
    }
  }

  /* ---- cümle odaklı analiz: cümle çevirisi + kelimelerin bu cümledeki anlamı, tek istekte ----
     Sonuç ctxDict[cümle]'de; aynı cümledeki diğer kelimeler beklemeden önbellekten gelir. */
  const ctxPending = new Map();          // cümle -> Set(istekteki kelimeler)
  const ctxAsked = new Map();            // cümle -> Set(cevabı alınmış istekteki kelimeler)
  const STOP = new Set(("the a an and or but if then else is are was were be been being to of in on at for with by " +
    "from as it its this that these those he she they we you i me my your our their his her them us not no yes do does " +
    "did done has have had will would can could should may might must shall so than too very just also only into onto " +
    "over under about after before up down out off what which who whom whose when where why how all any each some " +
    "such there here more most other own same both few nor").split(" "));

  function ctxEligible(sentence) {
    return !!sentence && sentence.length >= 12 && (sentence.match(HL_WORD) || []).length >= 3;
  }
  function ctxWord(sentence, w) {
    const e = sentence && ctxDict[sentence];
    return (e && e.w && e.w[w]) || null;
  }
  function ctxIsPending(sentence) { return ctxPending.has(sentence); }
  function ctxWasAsked(sentence, w) { const a = ctxAsked.get(sentence); return !!a && a.has(w); }

  /* kısa terim ipucu: alan sözlüğündeki uzun açıklamanın baş kısmı */
  function shortGloss(g) {
    const v = String(g[curDomain()] || g.devops || g.software || g.general || "");
    const head = v.split(/[:;.(]/)[0].trim();
    return (head.length >= 3 ? head : v).slice(0, 50);
  }
  function candidatesOf(w) {
    const out = [];
    const add = (x) => { x = String(x || "").trim(); if (x && !out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x); };
    add(lookupDict(w));
    (MEANINGS[w] || []).forEach(add);
    (meaningsDict[w] || []).forEach(add);
    return out.slice(0, 4);
  }

  /* metinde geçen alan sözlüğü terimleri (çeviri promptuna ipucu) */
  function termsIn(text) {
    const out = [], seen = new Set();
    for (const m of text.match(HL_WORD) || []) {
      const w = m.toLowerCase();
      if (seen.has(w)) continue;
      seen.add(w);
      const g = glossOf(w);
      if (g && typeof g === "object") out.push({ w, t: shortGloss(g) });
      if (out.length >= 8) break;
    }
    return out;
  }

  /* prefetch=true: arka plan ön çevirisi (focus yok, en düşük öncelik). Gönderildiyse true döner. */
  function requestAnalyze(sentence, focus, { prefetch = false } = {}) {
    if (llmDown && Date.now() - llmDownAt > 60000) llmDown = false;
    if (llmDown || ctxPending.has(sentence) || (focus && ctxWasAsked(sentence, focus))) return false;
    const have = (ctxDict[sentence] && ctxDict[sentence].w) || {};
    const targets = [], terms = [], seen = new Set();
    const consider = (raw, isFocus) => {
      const w = raw.toLowerCase().replace(/^[-']+|[-']+$/g, "");
      if (seen.has(w) || w.length < 3 || /\d/.test(w)) return;
      seen.add(w);
      const g = glossOf(w);
      if (g && typeof g === "object") { terms.push({ w, t: shortGloss(g) }); if (!isFocus) return; }
      if (!isFocus && (STOP.has(w) || have[w] || known.has(w) || ctxWasAsked(sentence, w))) return;
      if (targets.length < 12) targets.push({ w, c: candidatesOf(w) });
    };
    if (focus) consider(focus, true);
    for (const m of sentence.match(HL_WORD) || []) consider(m, false);
    if (!targets.length) { if (prefetch) { bgSkipped.add(sentence); scheduleWidget(); } return false; }
    ctxPending.set(sentence, new Set(targets.map((x) => x.w)));
    if (prefetch) { bgPending.add(sentence); bgInflight++; bgSent++; }
    const finish = () => {
      ctxPending.delete(sentence);
      if (prefetch) { bgPending.delete(sentence); bgInflight--; setTimeout(pumpBg, 0); scheduleWidget(); }
    };
    try {
      chrome.runtime.sendMessage({
        type: "krh-analyze", sentence, focus: focus || "", targets, terms, prefetch,
        domainLabel: DOMAIN_LABELS[curDomain()] || "genel"
      }, (resp) => {
        const asked = ctxPending.get(sentence);
        finish();
        if (chrome.runtime.lastError) return;
        if (!(resp && resp.cancelled) && !(resp && resp.down) && asked) {
          const a = ctxAsked.get(sentence) || new Set();
          asked.forEach((x) => a.add(x));
          ctxAsked.set(sentence, a);
        }
        if (resp && resp.cancelled) {                // imleç başka cümleye geçti / sekme gizlendi: tekrar sorulabilir
          if (prefetch) bgDone.delete(sentence);
          if (ctx && ctx.sentence === sentence) renderTip();
          return;
        }
        if (!resp || !resp.entry) {
          if (resp && resp.down) { llmDown = true; llmDownAt = Date.now(); }
          else if (prefetch) bgFailed.add(sentence);
          if (ctx && ctx.sentence === sentence) renderTip();   // başarısızsa kelime çevirisine düşer
          return;
        }
        // kalıcı kayıt background'da; bellekteki kopyalar:
        ctxDict[sentence] = resp.entry;
        sentenceDict[sentence] = resp.entry.tr;
        for (const [w, v] of Object.entries(resp.entry.w || {})) if (!userDict[w] && !lookupDict(w)) userDict[w] = v.a;
        if (ctx && ctx.sentence === sentence) { renderTip(); placeTip(ctx.rect); }
      });
    } catch (e) {
      finish();
      llmDown = true;
      llmDownAt = Date.now();
      return false;
    }
    return true;
  }

  /* ---- arka plan ön çevirisi: ekranda görünen paragrafların cümleleri sırayla analiz edilir ----
     Sen bir kelimenin üzerine gelmeden önce cümlesi hazır olur, balon anında açılır.
     Background'da en düşük öncelikte ve tek slotla çalışır; hover her zaman önce gelir. */
  const BLOCK_SEL = "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, td, th, figcaption, summary";
  const PREFETCH_PAGE_MAX = 300;         // sayfa başına en fazla ön çeviri isteği
  const BG_INFLIGHT = 2;                 // background'a aynı anda gönderilen (1 çalışır, 1 bekler)
  const DWELL = 800;                     // paragraf en az bu kadar ekranda kalmalı (hızlı kaydırmada istek yok)
  let io = null, observed = new WeakSet(), bgScanTimer = null;
  const visibleBlocks = new Set();
  const dwellTimers = new Map();
  let bgQueue = [];                      // [{s, el}]
  let bgInflight = 0, bgSent = 0;
  const bgDone = new Set();              // kuyruğa alınmış/işlenmiş cümleler
  const bgPending = new Set();           // background'da bekleyen ön çeviri cümleleri
  const promoted = new Set();
  const prefetchBlocks = [];             // izlenen paragraflar (belge sırası)
  const pageSents = new Set();           // sayfadaki çevrilebilir cümleler (yüzde paydası)
  const bgSkipped = new Set();           // çevrilecek bilinmeyen kelime yok (bilinen/sık kelimeler)
  const bgFailed = new Set();            // ön çevirisi başarısız cümleler
  let bgPaused = false, bgAllMode = false;

  function prefetchOn() {
    return enabled && settings.autoTranslate !== false && !/^tr\b/i.test(document.documentElement.lang || "");
  }

  /* blok metnini, sentenceAround ile birebir aynı sınırlarla cümlelere böl (önbellek anahtarları eşleşsin) */
  function sentencesOf(full) {
    const out = [];
    let st = 0;
    for (let i = 0; i < full.length; i++) {
      if (".!?…\n".includes(full[i])) { out.push(full.slice(st, i + 1)); st = i + 1; }
    }
    if (st < full.length) out.push(full.slice(st));
    return out.map((x) => x.replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean);
  }
  function looksEnglish(sn) {
    const ws = sn.match(/[A-Za-zçğıöşüÇĞİÖŞÜ]+/g) || [];
    if (ws.length < 3) return false;
    const tr = ws.filter((w) => /[çğıöşüÇĞİÖŞÜ]/.test(w)).length;
    return tr / ws.length < 0.15;
  }

  function setupPrefetch() {
    if (!prefetchOn() || !("IntersectionObserver" in window)) { stopPrefetch(); return; }
    if (!io) io = new IntersectionObserver(onIntersect, { rootMargin: "150px 0px" });
    scanBlocks();
  }
  function stopPrefetch() {
    if (io) { io.disconnect(); io = null; }
    observed = new WeakSet();
    visibleBlocks.clear();
    dwellTimers.forEach((t) => clearTimeout(t));
    dwellTimers.clear();
    bgQueue = [];
    prefetchBlocks.length = 0;
    pageSents.clear();
    if (bgPending.size) try { chrome.runtime.sendMessage({ type: "krh-bg-cancel" }, () => void chrome.runtime.lastError); } catch (e) {}
    scheduleWidget();
  }
  function scheduleBlockScan(ms) {
    if (!io) return;
    clearTimeout(bgScanTimer);
    bgScanTimer = setTimeout(scanBlocks, ms);
  }
  function scanBlocks() {
    if (!io) return;
    let n = 0;
    for (const el of document.querySelectorAll(BLOCK_SEL)) {
      if (n >= 2000) break;
      if (observed.has(el)) continue;
      observed.add(el);
      if (el.closest("#krh-tip, nav, footer, [contenteditable=''], [contenteditable='true']")) continue;
      if (el.querySelector(BLOCK_SEL)) continue;            // yalnız en içteki bloklar
      const len = el.textContent.length;
      if (len < 20 || len > 5000) continue;
      io.observe(el);
      prefetchBlocks.push(el);
      for (const sn of sentencesOf(el.textContent)) if (ctxEligible(sn) && looksEnglish(sn)) pageSents.add(sn);
      n++;
    }
    if (bgAllMode) enqueueAll();
    scheduleWidget();
  }
  function onIntersect(entries) {
    for (const en of entries) {
      const el = en.target;
      if (en.isIntersecting) {
        visibleBlocks.add(el);
        if (!dwellTimers.has(el)) {
          dwellTimers.set(el, setTimeout(() => {
            dwellTimers.delete(el);
            if (visibleBlocks.has(el)) enqueueBlock(el);
          }, DWELL));
        }
      } else {
        visibleBlocks.delete(el);
        clearTimeout(dwellTimers.get(el));
        dwellTimers.delete(el);
      }
    }
    scheduleWidget();
  }
  function enqueueBlock(el) {
    for (const sn of sentencesOf(el.textContent)) {
      if (bgDone.has(sn) || ctxDict[sn] || bgSkipped.has(sn) || bgFailed.has(sn) ||
          !ctxEligible(sn) || !looksEnglish(sn)) continue;
      bgDone.add(sn);
      bgQueue.push({ s: sn, el });
    }
    pumpBg();
    scheduleWidget();
  }
  function enqueueAll() { prefetchBlocks.forEach((el) => enqueueBlock(el)); }
  function pumpBg() {
    if (llmDown && Date.now() - llmDownAt > 60000) llmDown = false;
    if (llmDown) { setTimeout(pumpBg, 61000); scheduleWidget(); return; }
    while (!bgPaused && bgInflight < BG_INFLIGHT && bgQueue.length && bgSent < PREFETCH_PAGE_MAX &&
           !document.hidden && prefetchOn()) {
      // önce hâlâ ekranda olan paragraflar; "tüm sayfa" modunda sonra belge sırasıyla geri kalanlar.
      // Normal modda ekrandan çıkanlar düşer, yeniden görünürse tekrar sıraya girer.
      let i = bgQueue.findIndex((q) => visibleBlocks.has(q.el));
      if (i < 0 && bgAllMode) i = 0;
      if (i < 0) { bgQueue.forEach((q) => bgDone.delete(q.s)); bgQueue = []; break; }
      const [it] = bgQueue.splice(i, 1);
      if (ctxDict[it.s]) continue;
      requestAnalyze(it.s, null, { prefetch: true });
    }
  }
  /* ---- köşe rozeti: ön çeviri ilerlemesi (tıklayınca ayrıntı paneli) ----
     Shadow DOM içinde; sayfanın CSS'i etkilemez, hover/seçim olayları bu kutuyu yok sayar. */
  let wHost = null, wRoot = null, wOpen = false, wHidden = false, wTimer = null;
  const W_CSS = `
    :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: #e8e9ec; }
    .pill { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
      background: #232428; border: 1px solid #3a3b44; border-radius: 999px; padding: 6px 12px;
      box-shadow: 0 6px 20px rgba(0,0,0,.45); }
    .pill:hover { border-color: #5b5d6a; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6f7a; }
    .dot.run { background: #f2b84b; animation: pulse 1s ease-in-out infinite; }
    .dot.ok { background: #5fcf80; } .dot.err { background: #e86a6a; }
    @keyframes pulse { 50% { opacity: .35; } }
    .panel { position: absolute; right: 0; bottom: calc(100% + 8px); width: 260px; background: #232428;
      border: 1px solid #3a3b44; border-radius: 12px; padding: 12px; box-shadow: 0 10px 34px rgba(0,0,0,.55); }
    .panel[hidden] { display: none; }
    .title { font-weight: 600; margin-bottom: 8px; display: flex; justify-content: space-between; }
    .bar { height: 6px; background: #3a3b44; border-radius: 3px; overflow: hidden; margin-bottom: 10px; }
    .fill { height: 100%; background: #6aa9ff; width: 0; transition: width .3s; }
    .row { display: flex; justify-content: space-between; color: #b9bcc6; }
    .row b { color: #e8e9ec; font-weight: 600; }
    .status { margin-top: 8px; color: #9ec9f0; }
    .btns { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    button { all: unset; cursor: pointer; background: #3c4043; border-radius: 6px; padding: 4px 9px; font-size: 12px; }
    button:hover { background: #4a4f55; }
    .x { background: none; padding: 0 2px; color: #9aa0a6; }`;

  function ensureWidget() {
    if (wHost) return;
    wHost = document.createElement("div");
    wHost.id = "krh-progress";
    wRoot = wHost.attachShadow({ mode: "open" });
    const st = document.createElement("style");
    st.textContent = W_CSS;
    wRoot.appendChild(st);
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    panel.innerHTML =                       // sabit iskelet; değişken metinler textContent ile yazılır
      '<div class="title"><span>🌐 Arka plan çevirisi</span><button class="x" data-a="hide" title="Bu sayfada gizle">✕</button></div>' +
      '<div class="bar"><div class="fill"></div></div>' +
      '<div class="row"><span>Sayfa</span><b data-k="page"></b></div>' +
      '<div class="row"><span>Ekranda</span><b data-k="vis"></b></div>' +
      '<div class="row"><span>Sırada / çevriliyor</span><b data-k="queue"></b></div>' +
      '<div class="row" data-k="failrow"><span>Hata</span><b data-k="fail"></b></div>' +
      '<div class="status" data-k="status"></div>' +
      '<div class="btns"><button data-a="pause"></button><button data-a="all"></button></div>';
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.innerHTML = '<span class="dot"></span><span data-k="pct"></span>';
    wRoot.append(panel, pill);
    pill.addEventListener("click", () => { wOpen = !wOpen; renderWidget(); });
    panel.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("button") && e.target.closest("button").dataset.a;
      if (a === "hide") { wHidden = true; renderWidget(); }
      if (a === "pause") setBgPaused(!bgPaused);
      if (a === "all") {
        bgAllMode = !bgAllMode;
        if (bgAllMode) enqueueAll(); else pumpBg();
        renderWidget();
      }
    });
    (document.body || document.documentElement).appendChild(wHost);
  }

  function setBgPaused(v) {
    bgPaused = v;
    if (v) {
      if (bgPending.size) try { chrome.runtime.sendMessage({ type: "krh-bg-cancel" }, () => void chrome.runtime.lastError); } catch (e) {}
    } else {
      if (bgAllMode) enqueueAll(); else visibleBlocks.forEach((el) => enqueueBlock(el));
      pumpBg();
    }
    renderWidget();
  }

  function progressStats() {
    const isDone = (sn) => !!ctxDict[sn] || bgSkipped.has(sn);
    let done = 0, fail = 0;
    pageSents.forEach((sn) => { if (isDone(sn)) done++; else if (bgFailed.has(sn)) fail++; });
    const vis = new Set();
    visibleBlocks.forEach((el) => sentencesOf(el.textContent).forEach((sn) => { if (pageSents.has(sn)) vis.add(sn); }));
    let visDone = 0;
    vis.forEach((sn) => { if (isDone(sn)) visDone++; });
    return { total: pageSents.size, done, fail, vis: vis.size, visDone, queued: bgQueue.length, running: bgInflight };
  }

  function scheduleWidget() {
    if (wTimer) return;
    wTimer = setTimeout(() => { wTimer = null; renderWidget(); }, 300);
  }

  function renderWidget() {
    const show = prefetchOn() && !wHidden && pageSents.size > 0;
    if (!show) { if (wHost) wHost.style.setProperty("display", "none", "important"); return; }
    ensureWidget();
    wHost.style.removeProperty("display");
    const q = (k) => wRoot.querySelector(`[data-k="${k}"]`);
    const s = progressStats();
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    const busy = !bgPaused && (s.running > 0 || s.queued > 0);
    let status, dot;
    if (llmDown) { status = "⚠ Ollama'ya ulaşılamıyor (1 dk sonra tekrar denenecek)"; dot = "err"; }
    else if (bgPaused) { status = "⏸ Duraklatıldı"; dot = ""; }
    else if (busy) { status = "⏳ Çevriliyor…"; dot = "run"; }
    else if (bgSent >= PREFETCH_PAGE_MAX) { status = `Sayfa sınırına ulaşıldı (${PREFETCH_PAGE_MAX} istek)`; dot = ""; }
    else if (s.done >= s.total) { status = "✓ Sayfanın tamamı hazır"; dot = "ok"; }
    else if (s.visDone >= s.vis) { status = bgAllMode ? "⏳ Sıradaki paragraflar bekleniyor…" : "✓ Ekrandakiler hazır — kaydırdıkça devam eder"; dot = "ok"; }
    else { status = "⏳ Bekleniyor…"; dot = "run"; }

    q("pct").textContent = `%${pct}`;
    wRoot.querySelector(".dot").className = "dot " + dot;
    const panel = wRoot.querySelector(".panel");
    panel.hidden = !wOpen;
    if (!wOpen) return;
    wRoot.querySelector(".fill").style.width = pct + "%";
    q("page").textContent = `${s.done} / ${s.total} cümle · %${pct}`;
    q("vis").textContent = `${s.visDone} / ${s.vis}`;
    q("queue").textContent = `${s.queued} / ${s.running}`;
    q("fail").textContent = String(s.fail);
    q("failrow").style.display = s.fail ? "" : "none";
    q("status").textContent = status;
    wRoot.querySelector('[data-a="pause"]').textContent = bgPaused ? "▶ Devam et" : "⏸ Duraklat";
    wRoot.querySelector('[data-a="all"]').textContent = bgAllMode ? "Yalnız ekrandakiler" : "⇣ Tüm sayfayı çevir";
  }

  /* kullanıcı ön çevirisi kuyrukta bekleyen bir cümleye geldi: background'da öne al */
  function promoteIfQueued(sentence) {
    if (!bgPending.has(sentence) || promoted.has(sentence)) return;
    promoted.add(sentence);
    try { chrome.runtime.sendMessage({ type: "krh-promote", sentence }, () => void chrome.runtime.lastError); } catch (e) {}
  }

  /* çeviri metnini yaz, kelimenin karşılığını kalın göster (innerHTML yok) */
  function fillSentence(el, tr, k) {
    el.textContent = "";
    el.appendChild(document.createTextNode("🗨 "));
    const i = k ? tr.toLowerCase().indexOf(k.toLowerCase()) : -1;
    if (i < 0) { el.appendChild(document.createTextNode(tr)); return; }
    el.appendChild(document.createTextNode(tr.slice(0, i)));
    const b = document.createElement("b");
    b.className = "krh-hl";
    b.textContent = tr.slice(i, i + k.length);
    el.appendChild(b);
    el.appendChild(document.createTextNode(tr.slice(i + k.length)));
  }

  function addAlt(alt, txt) {
    const d = document.createElement("div");
    d.className = "krh-alt-item";
    d.textContent = txt;
    alt.appendChild(d);
  }

  function updateTipBtns() {
    if (!tip || !ctx) return;
    const st = known.has(ctx.w) ? "known" : learning.has(ctx.w) ? "learning" : null;
    tip.querySelectorAll("button[data-s]").forEach((b) =>
      b.classList.toggle("active", st === b.dataset.s));
  }

  function placeTip(rect) {
    const t = ensureTip();
    t.style.setProperty("visibility", "hidden", "important");
    t.classList.add("on");
    const tw = t.offsetWidth, th = t.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - tw - 8, rect.left + rect.width / 2 - tw / 2));
    let top = rect.bottom + 8;                        // varsayılan: kelimenin altı
    if (top + th > window.innerHeight - 8) top = rect.top - th - 8;   // altta yer yoksa üste çık
    if (top < 8) top = 8;                             // ikisinde de sığmazsa en üste sabitle
    // CSS'teki "all: initial !important" sıfırlamasını ezmek için konum important yazılır
    t.style.setProperty("left", left + "px", "important");
    t.style.setProperty("top", top + "px", "important");
    t.style.setProperty("visibility", "visible", "important");
  }

  /* ---- Ollama: background üzerinden çeviri (sayfa CSP'sine takılmaz) ---- */
  function requestLlm(word, sentence) {
    const w = word.toLowerCase();
    if (llmDown && Date.now() - llmDownAt > 60000) llmDown = false;   // ara sıra tekrar dene
    if (llmCache.has(w) || llmPending.has(w) || llmDown) return;
    llmPending.add(w);
    try {
      chrome.runtime.sendMessage(
        { type: "krh-translate", word, sentence, domainLabel: DOMAIN_LABELS[curDomain()] || "genel" },
        (resp) => {
          llmPending.delete(w);
          if (chrome.runtime.lastError) return;
          // imleç başka kelimeye geçti, istek kuyruktan düştü: önbelleğe yazma, tekrar sorulabilir
          if (resp && resp.cancelled) return;
          if (!resp || !resp.t) {
            llmCache.set(w, null);
            if (resp && resp.down) { llmDown = true; llmDownAt = Date.now(); }
            else llmFailed.add(w);
            if (ctx && ctx.w === w) renderTip();
            return;
          }
          // şemalı cevap: {t: anlam, other: [diğer anlamlar], note: Türkçe açıklama}
          const entry = { t: resp.t, other: resp.other || [], note: resp.note || "" };
          llmCache.set(w, entry);
          // kalıcı kayıt background'da yapıldı (userDict/meaningsDict/explainDict); bellekteki kopya:
          userDict[w] = entry.t;
          if (entry.other.length) meaningsDict[w] = entry.other;
          if (entry.note) explainDict[w] = entry.note;
          if (ctx && ctx.w === w) { renderTip(); placeTip(ctx.rect); }
        });
    } catch (e) {
      llmPending.delete(w);
      llmDown = true;
      llmDownAt = Date.now();
      if (ctx && ctx.w === w) renderTip();
    }
  }
})();
