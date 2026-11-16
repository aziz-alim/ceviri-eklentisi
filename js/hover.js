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
  let contextLog = {};                   // kelime -> [{s: cümle, h: site, t: zaman}] (en fazla 5/kelime)
  let ctxDirty = false, ctxFlushTimer = null;
  let known = new Set(), learning = new Set();

  const llmCache = new Map();            // oturum içi: kelime -> çeviri | null
  const llmPending = new Set();
  let llmDown = false;                   // Ollama erişilemiyorsa spinner gösterme
  let llmDownAt = 0;                     // 60 sn sonra otomatik tekrar dene

  let tip = null, showTimer = null, hideTimer = null, ctx = null;

  init();
  async function init() {
    try {
      const st = await chrome.storage.local.get(
        ["settings", "siteRules", "siteDomains", "customGlossary", "userDict", "meaningsDict",
         "explainDict", "sentenceDict", "contextLog", "knownWords", "learningWords"]);
      if (st.settings) settings = { ...settings, ...st.settings };
      siteRules = st.siteRules || {};
      siteDomains = st.siteDomains || {};
      enabled = isEnabled();
      customGlossary = st.customGlossary || {};
      userDict = st.userDict || {};
      meaningsDict = st.meaningsDict || {};
      explainDict = st.explainDict || {};
      sentenceDict = st.sentenceDict || {};
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
      }
      if (chg.siteRules) {
        siteRules = chg.siteRules.newValue || {};
        enabled = isEnabled();
        if (!enabled) hideTip(true);
        refreshHlState();
      }
      if (chg.siteDomains) siteDomains = chg.siteDomains.newValue || {};
      if (chg.customGlossary) customGlossary = chg.customGlossary.newValue || {};
      if (chg.userDict) userDict = chg.userDict.newValue || {};
      if (chg.meaningsDict) meaningsDict = chg.meaningsDict.newValue || {};
      if (chg.explainDict) explainDict = chg.explainDict.newValue || {};
      if (chg.sentenceDict) sentenceDict = chg.sentenceDict.newValue || {};
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

    return { word, rect, sentence: sentenceAround(text, start, end), phrase };
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

  /* ---- anlam çözümleme (wordui.js ile aynı öncelik sırası) ---- */
  function analyze(word) {
    const w = word.toLowerCase();
    const gloss = GLOSSARY[curDomain()]?.[w] || GLOSSARY.software?.[w] || customGlossary?.[w] || null;
    const cached = llmCache.get(w);      // {t, other, note} | null | undefined
    const base = lookupDict(w) || (cached && cached.t) || null;
    return { w, gloss, base };
  }

  /* ---- mouse akışı ---- */
  function onMouseMove(e) {
    if (!enabled) return;
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
    arr.unshift({ s: c.sentence.slice(0, 200), h: HOST, t: Date.now() });
    if (arr.length > 5) arr.length = 5;
    const keys = Object.keys(contextLog);
    if (keys.length > 1500) delete contextLog[keys[0]];    // depo şişmesin
    ctxDirty = true;
    clearTimeout(ctxFlushTimer);
    ctxFlushTimer = setTimeout(() => {
      ctxDirty = false;
      chrome.storage.local.set({ contextLog }).catch(() => {});
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
      try {
        await chrome.storage.local.set({ knownWords: [...known], learningWords: [...learning] });
      } catch (e) {}
      updateTipBtns();
    }));
    tip.querySelector('[data-a="retr"]').addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await retranslate();
    });
    tip.querySelector('[data-a="speak"]').addEventListener("click", (ev) => {
      ev.stopPropagation();
      speakWord();
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

  /* 🔄 baştan çevirt: seçim modunda cümleleri, kelime modunda kelime kaydını sil ve yeniden sor */
  async function retranslate() {
    if (!ctx) return;
    if (ctx.sel) {
      if (sentPending.has(ctx.text)) return;
      delete sentenceDict[ctx.text];
      for (const s of splitSentences(ctx.text)) delete sentenceDict[s];   // parça kayıtlarını da tazele
      try { await chrome.storage.local.set({ sentenceDict }); } catch (e) {}
      llmDown = false;
      llmDownAt = 0;
      renderTip();
      return;
    }
    const w = ctx.w;
    if (llmPending.has(w)) return;
    llmCache.delete(w);
    delete userDict[w];
    delete meaningsDict[w];
    delete explainDict[w];
    try {
      await chrome.storage.local.set({ userDict, meaningsDict, explainDict });
    } catch (e) {}
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
      if (gloss) {
        const domainMeaning = gloss[curDomain()] || gloss.devops || gloss.software ||
          Object.values(gloss).find((v) => typeof v === "string");
        mainTxt = "✅ " + domainMeaning;
        if (gloss.general) addAlt(alt, "genel: " + gloss.general);
      } else if (base) {
        mainTxt = base;
      } else if (llmPending.has(w)) {
        mainTxt = "⏳ çevriliyor… (Ollama — local)";
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
      const bn = (base || "").toLowerCase();
      arr.filter((m) => m && m.toLowerCase() !== bn).slice(0, 2)
        .forEach((m) => addAlt(alt, "• " + m));
      // Türkçe açıklama: LLM şemasından ya da kalıcı depodan
      const noteTxt = (cached && cached.note) || explainDict[w] || "";
      if (noteTxt) {
        note.textContent = "💬 " + noteTxt;
        note.classList.remove("krh-off");
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

  function splitSentences(text) {
    return text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  }

  function requestSentence(text) {
    if (sentPending.has(text) || llmDown) return;
    sentPending.add(text);
    const parts = splitSentences(text);
    const payload = parts.length > 1
      ? { type: "krh-sentence-batch", sentences: parts }
      : { type: "krh-sentence", sentence: text };
    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        sentPending.delete(text);
        if (chrome.runtime.lastError || !resp || resp.down || (!resp.t && !resp.arr)) {
          if (resp && resp.down) { llmDown = true; llmDownAt = Date.now(); }
          if (ctx && ctx.sentence === text) renderTip();
          return;
        }
        if (resp.arr && resp.arr.length === parts.length) {
          parts.forEach((s, i) => { if (resp.arr[i]) sentenceDict[s] = resp.arr[i]; });
          sentenceDict[text] = resp.arr.filter(Boolean).join(" ");   // paragraf bütünü
        } else if (resp.t) {
          sentenceDict[text] = resp.t;
        }
        const keys = Object.keys(sentenceDict);
        while (keys.length > 2000) delete sentenceDict[keys.shift()];   // en eskiler atılır
        chrome.storage.local.set({ sentenceDict }).catch(() => {});
        if (ctx && ctx.sentence === text) { renderTip(); placeTip(ctx.rect); }
      });
    } catch (e) {
      sentPending.delete(text);
    }
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
          if (chrome.runtime.lastError || !resp || !resp.t) {
            llmCache.set(w, null);
            if (resp && resp.down) { llmDown = true; llmDownAt = Date.now(); }
            if (ctx && ctx.w === w) renderTip();
            return;
          }
          // şemalı cevap: {t: anlam, other: [diğer anlamlar], note: Türkçe açıklama}
          const entry = { t: resp.t, other: resp.other || [], note: resp.note || "" };
          llmCache.set(w, entry);
          userDict[w] = entry.t;                     // kalıcı sözlüğe ekle (yan panel de görür)
          if (entry.other.length) {
            meaningsDict[w] = entry.other;           // yan panelin "diğer anlamlar"ıyla aynı depo
            const mKeys = Object.keys(meaningsDict);
            if (mKeys.length >= 1500) delete meaningsDict[mKeys[0]];
          }
          if (entry.note) {
            explainDict[w] = entry.note;
            const eKeys = Object.keys(explainDict);
            if (eKeys.length >= 1500) delete explainDict[eKeys[0]];
          }
          chrome.storage.local.set({ userDict, meaningsDict, explainDict }).catch(() => {});
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
