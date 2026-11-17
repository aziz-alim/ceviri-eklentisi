/* Çeviri Eklentisi — service worker
   Görevleri:
   1) TEK Ollama katmanı: hover, yan panel ve okuyucunun bütün LLM istekleri buradan geçer
      (sıra + eşzamanlılık sınırı + zaman aşımı + şemalı JSON + saçma çıktı kontrolü).
   2) TEK yazma noktası: paylaşılan sözlük/durum verisi burada sırayla yazılır (sekmeler arası yarış yok).
   3) Alt+Shift+K ile hover çeviriyi aç/kapat + ikon rozeti. */

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  chrome.action.setBadgeBackgroundColor({ color: "#c792ea" });
  syncBadge();
  withStore(() => cleanupTranslations(false));   // şema v2'ye tek seferlik sessiz geçiş
  // siteRules artık BEYAZ LİSTE (true = açık): eski kara liste kayıtlarını (false) temizle
  const st = await chrome.storage.local.get(["siteRules"]);
  if (st.siteRules) {
    const sr = {};
    for (const [k, v] of Object.entries(st.siteRules)) if (v === true) sr[k] = true;
    await chrome.storage.local.set({ siteRules: sr });
  }
});

chrome.runtime.onStartup.addListener(syncBadge);

/* yerel saate göre gün anahtarı (UTC değil) */
function dayKey(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* ================= TEK YAZMA NOKTASI =================
   Bütün okuma-değiştirme-yazma işlemleri bu zincirde sırayla çalışır. */
let storeChain = Promise.resolve();
function withStore(fn) {
  const p = storeChain.then(fn, fn);
  storeChain = p.catch(() => {});
  return p;
}

const DICT_STORES = ["userDict", "meaningsDict", "explainDict", "sentenceDict", "ctxDict"];
const DICT_CAPS = { meaningsDict: 1500, explainDict: 1500, sentenceDict: 2000, ctxDict: 2000 };
const SENSES_MAX = 5;   // kelime katmanında tutulan farklı anlam sayısı
const CTX_PER_WORD = 5, CTX_MAX_WORDS = 1500;

/* ops: dictSet / dictDel / state / ctxAdd — bkz. js/store.js
   iç kullanım: ctxMerge (cümle analizini mevcut kayıtla birleştir), senseAdd (kelime katmanına anlam ekle) */
function applyOps(ops) {
  if (!Array.isArray(ops) || !ops.length) return Promise.resolve({ ok: true });
  return withStore(async () => {
    const need = new Set();
    for (const o of ops) {
      if ((o.op === "dictSet" || o.op === "dictDel") && DICT_STORES.includes(o.store)) need.add(o.store);
      else if (o.op === "state") { need.add("knownWords"); need.add("learningWords"); }
      else if (o.op === "ctxAdd") need.add("contextLog");
      else if (o.op === "ctxMerge") need.add("ctxDict");
      else if (o.op === "senseAdd") { need.add("userDict"); need.add("meaningsDict"); }
    }
    if (!need.size) return { ok: false };
    const st = await chrome.storage.local.get([...need]);
    const out = {};
    let known = null, learning = null;

    for (const o of ops) {
      if (o.op === "dictSet" || o.op === "dictDel") {
        if (!DICT_STORES.includes(o.store) || !o.key) continue;
        const key = o.store === "sentenceDict" ? String(o.key) : String(o.key).toLowerCase();
        const d = out[o.store] || (out[o.store] = st[o.store] || {});
        if (o.op === "dictDel" || o.value == null || o.value === "" ||
            (Array.isArray(o.value) && !o.value.length)) { delete d[key]; continue; }
        const cap = DICT_CAPS[o.store];
        if (cap && d[key] === undefined) {
          const keys = Object.keys(d);
          while (keys.length >= cap) delete d[keys.shift()];   // en eski kayıt atılır
        }
        d[key] = o.value;
      } else if (o.op === "state" && o.w) {
        if (!known) { known = new Set(st.knownWords || []); learning = new Set(st.learningWords || []); }
        const w = String(o.w).toLowerCase();
        known.delete(w); learning.delete(w);
        if (o.state === "known") known.add(w);
        if (o.state === "learning") learning.add(w);
      } else if (o.op === "ctxAdd" && o.w && o.entry && o.entry.s) {
        const cl = out.contextLog || (out.contextLog = st.contextLog || {});
        const w = String(o.w).toLowerCase();
        const arr = cl[w] || (cl[w] = []);
        if (arr.some((x) => x.s === o.entry.s)) continue;     // aynı cümle tekrar sayılmaz
        arr.unshift({ s: String(o.entry.s).slice(0, 200), h: o.entry.h || "", t: o.entry.t || Date.now() });
        if (arr.length > CTX_PER_WORD) arr.length = CTX_PER_WORD;
        const keys = Object.keys(cl);
        while (keys.length > CTX_MAX_WORDS) delete cl[keys.shift()];
      } else if (o.op === "ctxMerge" && o.key && o.value) {
        // cümle → { tr, w: {kelime: {a, k, l, n}}, t } ; yeni kelimeler eskilerle birleşir
        const d = out.ctxDict || (out.ctxDict = st.ctxDict || {});
        const key = String(o.key);
        const prev = d[key];
        if (!prev) {
          const keys = Object.keys(d);
          while (keys.length >= DICT_CAPS.ctxDict) delete d[keys.shift()];
        }
        d[key] = {
          tr: o.value.tr || (prev && prev.tr) || "",
          w: { ...((prev && prev.w) || {}), ...(o.value.w || {}) },
          t: Date.now()
        };
      } else if (o.op === "senseAdd" && o.w && o.a) {
        // kelime katmanı: ilk anlam temel karşılık olur, sonrakiler "diğer anlamlar"a eklenir
        const ud = out.userDict || (out.userDict = st.userDict || {});
        const md = out.meaningsDict || (out.meaningsDict = st.meaningsDict || {});
        const w = String(o.w).toLowerCase(), a = String(o.a);
        const al = a.toLowerCase();
        if (!ud[w]) { ud[w] = a; continue; }
        if (String(ud[w]).toLowerCase() === al) continue;
        const list = Array.isArray(md[w]) ? md[w] : [];
        if (list.some((x) => String(x).toLowerCase() === al)) continue;
        md[w] = [...list, a].slice(-SENSES_MAX);
      }
    }
    if (known) { out.knownWords = [...known]; out.learningWords = [...learning]; }
    if (Object.keys(out).length) await chrome.storage.local.set(out);
    return { ok: true };
  });
}

/* Ollama sonucunu kalıcı depolara yaz (kelime şeması: t / other / note) */
function saveWordResult(w, r) {
  const ops = [{ op: "dictSet", store: "userDict", key: w, value: r.t }];
  if (r.other && r.other.length) ops.push({ op: "dictSet", store: "meaningsDict", key: w, value: r.other });
  if (r.note) ops.push({ op: "dictSet", store: "explainDict", key: w, value: r.note });
  return applyOps(ops);
}
function saveSentences(map) {
  const ops = Object.entries(map).filter(([s, t]) => s && t)
    .map(([s, t]) => ({ op: "dictSet", store: "sentenceDict", key: s, value: t }));
  return applyOps(ops);
}


/* ---- Çeviri deposu temizliği: her kayıt tek şemada ----
   userDict:    kelime -> kısa anlam (≤ 40 kr, tırnaksız, tek satır)
   meaningsDict: kelime -> [diğer anlamlar] (dizi, tekrarsız, ana anlamı içermez)
   explainDict: kelime -> Türkçe açıklama (tek satır, ≤ 300 kr)
   Eski/bozuk kayıtlar: gömülü JSON ise parçalanıp doğru depolara dağıtılır;
   onarılamayan (aşırı uzun, çok satırlı) kayıtlar silinir — kelime bir sonraki
   hover'da yeni şemayla otomatik yeniden çevrilir. */
const KR_SCHEMA_V = 2;

async function cleanupTranslations(force) {
  const st = await chrome.storage.local.get(["userDict", "meaningsDict", "explainDict", "krSchemaV"]);
  if (!force && (st.krSchemaV || 0) >= KR_SCHEMA_V) return { skipped: true };

  const userDict = {}, meaningsDict = {}, explainDict = {};
  const stats = { fixed: 0, dropped: 0, kept: 0 };

  const clean = (v) => String(v == null ? "" : v)
    .replace(/```[a-z]*|```/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();

  // anahtarları küçük harfe normalize et — aramalar hep küçük harfle yapılacak
  const norm = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const lk = k.toLowerCase();
      if (out[lk] === undefined) out[lk] = v;
    }
    return out;
  };
  const srcUser = norm(st.userDict), srcMean = norm(st.meaningsDict), srcExpl = norm(st.explainDict);
  const keys = new Set([...Object.keys(srcUser), ...Object.keys(srcMean), ...Object.keys(srcExpl)]);

  for (const w of keys) {
    let meaning = null, others = [], note = "";

    // 1) explainDict (en temiz kaynak: zaten tek alan)
    note = clean(srcExpl[w]);

    // 2) meaningsDict: dizi değilse onarmaya çalış
    const mv = srcMean[w];
    if (Array.isArray(mv)) others = mv.map(clean).filter(Boolean);
    else if (mv && typeof mv === "object" && Array.isArray(mv.diger)) others = mv.diger.map(clean).filter(Boolean);
    else if (typeof mv === "string" && mv.trim()) others = [clean(mv)];

    // 3) userDict: düz metin ya da gömülü JSON olabilir
    let uv = srcUser[w];
    if (uv != null && typeof uv === "object") uv = uv.t || uv.anlam || "";
    let s = clean(uv);
    const jm = s.match(/\{[\s\S]*\}/);            // eski kayıtlarda ham JSON kalmış olabilir
    if (jm) {
      try {
        const o = JSON.parse(jm[0]);
        if (o.anlam) { meaning = clean(o.anlam); stats.fixed++; }
        if (Array.isArray(o.diger)) others = others.concat(o.diger.map(clean).filter(Boolean));
        if (!note && o.aciklama) note = clean(o.aciklama);
      } catch (e) { /* JSON bozuksa düz metin gibi devam */ }
    }
    if (!meaning) {
      if (s && s.length <= 40 && !s.includes("\n")) { meaning = s; }
      else if (s) {
        // uzun karışık kayıt: ilk anlamlı parçayı anlam, gerisini açıklama yap
        const seg = s.split(/\s[—–-]\s|\(|;|\./).map((x) => x.trim()).filter(Boolean);
        if (seg[0] && seg[0].length <= 40) {
          meaning = seg[0];
          if (!note && s.length > seg[0].length + 2) note = s;
          stats.fixed++;
        } else {
          stats.dropped++;                            // onarılamadı: sil, hover'da yeniden üretilir
          continue;
        }
      }
    }

    // 4) format son kontrolleri
    if (meaning) {
      userDict[w] = meaning;
      stats.kept++;
    }
    const mn = (meaning || "").toLowerCase();
    others = [...new Set(others)]
      .filter((o) => o && o.length <= 40 && o.toLowerCase() !== mn)
      .slice(0, 3);
    if (others.length) meaningsDict[w] = others;
    if (note && note.length <= 300 && note.toLowerCase() !== mn) explainDict[w] = note;
  }

  await chrome.storage.local.set({ userDict, meaningsDict, explainDict, krSchemaV: KR_SCHEMA_V });
  return { skipped: false, ...stats, total: keys.size };
}


async function syncBadge() {
  const st = await chrome.storage.local.get(["settings", "dailyStats"]);
  const enabled = !st.settings || st.settings.hoverEnabled !== false;
  if (!enabled) { chrome.action.setBadgeText({ text: "⏸" }); return; }
  const n = st.dailyStats?.[dayKey()]?.translated || 0;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });   // bugünkü çeviri sayısı
}

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-hover") return;
  const st = await chrome.storage.local.get(["settings"]);
  const settings = {
    domain: "devops", ollamaUrl: "http://localhost:11434", model: "llama3.1",
    hoverEnabled: true, ...(st.settings || {})
  };
  settings.hoverEnabled = !settings.hoverEnabled;
  await chrome.storage.local.set({ settings });
  syncBadge();
});

/* storage'dan hoverEnabled değişirse rozeti tazele */
chrome.storage.onChanged.addListener((chg, area) => {
  if (area === "local" && chg.settings) syncBadge();
});

/* ================= TEK OLLAMA KATMANI =================
   - Kuyruk: aynı anda en çok MAX_PARALLEL istek; etkileşimli istekler (hover, tıklama)
     arka plan toplu çevirilerin önüne geçer.
   - Hover'da imleç yeni bir kelimeye geçince, aynı sekmenin henüz başlamamış eski
     kelime istekleri kuyruktan düşer ({cancelled:true}).
   - Zaman aşımı: AbortSignal.timeout. Zaman aşımı "Ollama kapalı" sayılmaz
     (model ilk yüklenirken yavaş olabilir); bağlantı hatası 60 sn "kapalı" önbelleğine girer.
   - format: JSON şeması (Ollama ≥ 0.5). Eski sürüm şemayı reddederse "json" moduna düşülür.
   - Arka plan ön çevirisi (prefetch) en düşük öncelikte ve aynı anda en çok MAX_PREFETCH istekle
     çalışır; böylece hover için her zaman boş bir yer kalır. Kullanıcı ön çevirisi bekleyen bir
     cümleye gelirse istek öne alınır (promote). */
const MAX_PARALLEL = 2;
const MAX_PREFETCH = 1;
const PRI = { interactive: 0, batch: 1, prefetch: 2 };
let runningPrefetch = 0;
const queue = [];
let running = 0;
let ollamaDownUntil = 0;
let schemaUnsupported = false;

function insertByPriority(item) {
  let i = queue.length;
  while (i > 0 && queue[i - 1].priority > item.priority) i--;   // aynı öncelikte FIFO
  queue.splice(i, 0, item);
}
function enqueue(task, { priority = PRI.interactive, group = null, key = null } = {}) {
  return new Promise((resolve) => {
    insertByPriority({ task, resolve, priority, group, key });
    pump();
  });
}
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const it = queue[0];
    if (it.priority === PRI.prefetch && runningPrefetch >= MAX_PREFETCH) break;   // kuyruk sıralı: geri kalanı da prefetch
    queue.shift();
    running++;
    const pre = it.priority === PRI.prefetch;
    if (pre) runningPrefetch++;
    Promise.resolve().then(it.task)
      .then(it.resolve, () => it.resolve({ error: "beklenmeyen hata" }))
      .finally(() => { running--; if (pre) runningPrefetch--; pump(); });
  }
}
/* bekleyen arka plan isteğini etkileşimli önceliğe taşı */
function promote(key) {
  const i = queue.findIndex((q) => q.key === key);
  if (i < 0) return false;
  const [it] = queue.splice(i, 1);
  it.priority = PRI.interactive;
  insertByPriority(it);
  pump();
  return true;
}
function dropQueued(group) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].group === group) { queue[i].resolve({ cancelled: true }); queue.splice(i, 1); }
  }
}

async function getSettings() {
  const st = await chrome.storage.local.get(["settings"]);
  const s = st.settings || {};
  return { url: (s.ollamaUrl || "http://localhost:11434").replace(/\/+$/, ""), model: s.model || "llama3.1" };
}

/* tek bir /api/generate çağrısı → { raw } | { down } | { timeout } | { error } | { cancelled } */
function ollamaGenerate(prompt, { system, format, timeoutMs = 45000, priority, group, key, temperature = 0.1 } = {}) {
  if (Date.now() < ollamaDownUntil) return Promise.resolve({ down: true });
  return enqueue(async () => {
    if (Date.now() < ollamaDownUntil) return { down: true };
    const { url, model } = await getSettings();
    const body = { model, prompt, stream: false, options: { temperature } };
    if (system) body.system = system;
    if (format) body.format = (schemaUnsupported && typeof format === "object") ? "json" : format;
    try {
      let res = await fetch(url + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      // eski Ollama JSON şemasını tanımıyorsa (400) bir kez "json" moduyla dene
      if (res.status === 400 && body.format && typeof body.format === "object") {
        schemaUnsupported = true;
        body.format = "json";
        res = await fetch(url + "/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
      }
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { const j = await res.json(); if (j.error) msg += ": " + j.error; } catch (e) {}
        if (res.status === 403) msg += " (OLLAMA_ORIGINS ayarı eksik olabilir)";
        return { error: msg };
      }
      return { raw: ((await res.json()).response || "").trim() };
    } catch (e) {
      if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return { timeout: true };
      ollamaDownUntil = Date.now() + 60000;   // 1 dk boyunca hızlı "kapalı" dön
      return { down: true };
    }
  }, { priority, group, key });
}

/* ilk geçerli JSON nesnesi/dizisi: önce tam metin, sonra metin içinden ayıklama */
function parseJson(raw, kind) {
  try { return JSON.parse(raw); } catch (e) {}
  const m = raw.match(kind === "array" ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

/* başarısız sonucu arayüze taşınacak forma çevir */
function failOf(r) {
  if (r.down) return { down: true };
  if (r.cancelled) return { cancelled: true };
  if (r.timeout) return { error: "zaman aşımı (model yavaş ya da yükleniyor)" };
  return { error: r.error || "geçersiz yanıt" };
}

const strArr = (n) => ({ type: "array", items: { type: "string" }, ...(n ? { maxItems: n } : {}) });
const SCHEMA = {
  analyze: {
    type: "object",
    properties: {
      ceviri: { type: "string" },
      kelimeler: {
        type: "array",
        items: {
          type: "object",
          properties: { kelime: { type: "string" }, kok: { type: "string" }, anlam: { type: "string" }, karsilik: { type: "string" } },
          required: ["kelime", "kok", "anlam", "karsilik"]
        }
      },
      aciklama: { type: "string" }
    },
    required: ["ceviri", "kelimeler", "aciklama"]
  },
  word: {
    type: "object",
    properties: { anlam: { type: "string" }, diger: strArr(3), aciklama: { type: "string" } },
    required: ["anlam", "diger", "aciklama"]
  },
  sentences: { type: "object", properties: { ceviriler: strArr() }, required: ["ceviriler"] },
  meanings: { type: "object", properties: { anlamlar: strArr(3) }, required: ["anlamlar"] },
  wordBatch: {
    type: "object",
    properties: {
      kelimeler: {
        type: "array",
        items: { type: "object", properties: { w: { type: "string" }, t: { type: "string" } }, required: ["w", "t"] }
      }
    },
    required: ["kelimeler"]
  }
};

/* çevirmen kimliği: modelin talimatları tekrarlamasını engeller */
const TR_SYS =
  "Sen İngilizce'den Türkçe'ye çeviri yapan profesyonel bir çevirmensin. " +
  "Çıktın YALNIZCA istenen çeviri metnidir. Talimatları, kuralları veya kaynak metni asla tekrar etmezsin; " +
  "açıklama, başlık, not veya yorum eklemezsin.";

/* cevap "saçma" mı? — talimat tekrarı / meta konuşma / kaynak yankısı tespiti */
function looksLikeMeta(t, src) {
  if (!t) return true;
  const low = t.toLowerCase();
  const bad = [
    "kural", "talimat", "json", "cümle:", "çeviri:", "çevirisi:",
    "işte çeviri", "işte çevirisi", "tabii", "elbette", "memnuniyetle",
    "translation:", "sure,", "here is", "as an ai", "i cannot", "i can't"
  ];
  if (bad.some((b) => low.includes(b))) return true;
  if (src) {
    const s = src.toLowerCase();
    if (s.length >= 20 && low.includes(s.slice(0, Math.min(60, s.length)))) return true; // girişi aynen tekrarlıyor
    if (t.length > src.length * 3 + 150) return true;   // aşırı uzun = açıklama yapıştırmış
  }
  return false;
}

const unquote = (s) => String(s == null ? "" : s).trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();

/* ---- işlemler ---- */

/* tek cümle çevirisi — doğrulamalı, gerekiyorsa kendi kendine tekrar dener */
/* alan sözlüğü ipuçları: [{w,t}] → "Terimler: ..." satırı */
function termLine(terms) {
  const l = (Array.isArray(terms) ? terms : []).slice(0, 8)
    .map((x) => `${String(x && x.w || "").slice(0, 40)} = ${String(x && x.t || "").slice(0, 60)}`).filter((x) => !x.startsWith(" ="));
  return l.length ? `Terimler (çeviride bu karşılıkları kullan): ${l.join("; ")}\n` : "";
}

async function opSentence(sentence, { retries = 3, priority, terms } = {}) {
  const prompt = termLine(terms) +
    `Aşağıdaki İngilizce cümleyi Türkçeye çevir.\n` +
    `Kurallar: TEK bir çeviri ver (teknik/doğal gibi ayrımlar yapma, alternatif sunma); ` +
    `akıcı ve doğal olsun; teknik terimleri gerekiyorsa aynen bırak; ` +
    `açıklama, not veya başlık ekleme; yalnızca çeviriyi yaz.\n\nCümle: "${sentence}"`;
  for (let i = 0; i < retries; i++) {
    const r = await ollamaGenerate(prompt, { system: TR_SYS, priority });
    if (r.raw === undefined) return failOf(r);
    // model yine de iki satır/alternatif dönerse ilk anlamlı satırı al
    const t = unquote(r.raw.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "");
    if (t && !looksLikeMeta(t, sentence)) {
      await saveSentences({ [sentence]: t });
      return { t };
    }
  }
  return { error: "model geçerli bir çeviri üretmedi" };
}

/* cümle listesi tek istekte; sıra/sayı tutmazsa null */
async function opSentenceBatch(sentences, { priority = PRI.interactive, whole, terms } = {}) {
  const sents = Array.isArray(sentences) ? sentences.slice(0, 30) : [];
  if (!sents.length) return { error: "boş liste" };
  const prompt = termLine(terms) +
    "Aşağıdaki İngilizce cümleleri Türkçeye çevir. Kurallar: her cümle için TEK, akıcı ve doğal bir çeviri; " +
    "açıklama ekleme; teknik terimleri gerekiyorsa aynen bırak. Girdi cümleleriyle BİREBİR AYNI SIRADA ve " +
    "aynı sayıda öğe içeren {\"ceviriler\": [\"çeviri1\", \"çeviri2\", ...]} JSON nesnesi döndür.\n\n" +
    sents.map((s, i) => (i + 1) + ". \"" + s + "\"").join("\n");
  let arr = null;
  for (let i = 0; i < 2 && !arr; i++) {
    const r = await ollamaGenerate(prompt, { system: TR_SYS, format: SCHEMA.sentences, timeoutMs: 120000, priority });
    if (r.raw === undefined) return failOf(r);
    const o = parseJson(r.raw, "object");
    const list = Array.isArray(o) ? o : (o && Array.isArray(o.ceviriler) ? o.ceviriler : parseJson(r.raw, "array"));
    if (Array.isArray(list) && list.length === sents.length) arr = list.map((x) => unquote(x));
  }
  if (!arr) return { error: "toplu çeviri sırası tutmadı" };
  // saçma görünen öğeleri tek tek, doğrulamalı yolla tazele
  for (let i = 0; i < arr.length; i++) {
    if (looksLikeMeta(arr[i], sents[i])) {
      const one = await opSentence(sents[i], { retries: 2, priority, terms });
      if (one.t) arr[i] = one.t;
    }
  }
  const map = {};
  sents.forEach((s, i) => { if (arr[i]) map[s] = arr[i]; });
  if (whole) map[whole] = arr.filter(Boolean).join(" ");   // seçilen paragrafın bütünü
  await saveSentences(map);
  return { arr };
}

/* hover kelime analizi: anlam + diğer anlamlar + açıklama; sonuç kalıcı sözlüğe yazılır */
async function opWord(word, sentence, domainLabel, group) {
  const domain = domainLabel || "genel";
  const prompt =
    `İngilizce kelimeyi ${domain} bağlamında analiz et.\n` +
    `Kelime: "${word}"\n` +
    (sentence ? `Cümle: "${sentence}"\n` : "") +
    `YALNIZCA şu JSON şemasında cevap ver:\n` +
    `{"anlam":"kelimenin bu bağlamdaki en uygun Türkçe karşılığı (en fazla 3 kelime)",` +
    `"diger":["varsa diğer yaygın anlam 1","diğer yaygın anlam 2"],` +
    `"aciklama":"kelimenin bu cümledeki kullanımını açıklayan 1 cümlelik Türkçe açıklama"}\n` +
    `Kurallar: teknik terimi gerekiyorsa aynen bırak; "diger" listesi boş olabilir ama anahtarlar hep bulunur.`;
  const r = await ollamaGenerate(prompt, { system: TR_SYS, format: SCHEMA.word, timeoutMs: 45000, group });
  if (r.raw === undefined) return failOf(r);

  let out = null;
  const o = parseJson(r.raw, "object");
  if (o && o.anlam) {
    const t = unquote(o.anlam);
    if (t) {
      out = {
        t,
        other: (Array.isArray(o.diger) ? o.diger : []).map(unquote)
          .filter((x) => x && x.toLowerCase() !== t.toLowerCase()).slice(0, 3),
        note: unquote(o.aciklama)
      };
    }
  }
  if (!out) {
    const t = unquote(r.raw);
    if (t && t.length <= 40 && !t.includes("\n")) out = { t, other: [], note: "" };   // düz metin dönerse
  }
  if (!out) return { error: "geçersiz yanıt" };
  await saveWordResult(word.toLowerCase(), out);
  bumpDaily();
  return out;
}

/* kısa karşılık (yan paneldeki 🔄 yeniden çevir) */
async function opWordShort(word, domainLabel) {
  const r = await ollamaGenerate(
    `"${word}" İngilizce kelimesini ${domainLabel || "genel"} bağlamında Türkçeye çevir. ` +
    `Kurallar: en fazla 3 kelimelik kısa karşılık; teknik terimi gerekiyorsa aynen bırak. ` +
    `YALNIZCA karşılığı yaz, başka hiçbir şey ekleme.`, { system: TR_SYS });
  if (r.raw === undefined) return failOf(r);
  const t = unquote(r.raw.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "");
  if (!t || looksLikeMeta(t, word) || t.length > 60) return { error: "geçersiz yanıt" };
  await applyOps([{ op: "dictSet", store: "userDict", key: word, value: t }]);
  return { t };
}

/* en yaygın 3 anlam (yan panel "diğer anlamlar") */
async function opMeanings(word) {
  const r = await ollamaGenerate(
    `İngilizce "${word}" kelimesinin en yaygın 3 Türkçe anlamını, en sık kullanımdan daha nadir olana doğru ` +
    `sıralayarak {"anlamlar":["anlam1","anlam2","anlam3"]} JSON nesnesi olarak döndür. ` +
    `Kurallar: her anlam en fazla 4 kelime; teknik bağlam öncelikli.`, { system: TR_SYS, format: SCHEMA.meanings });
  if (r.raw === undefined) return failOf(r);
  const o = parseJson(r.raw, "object");
  const list = (Array.isArray(o) ? o : (o && Array.isArray(o.anlamlar) ? o.anlamlar : []))
    .map(unquote).filter(Boolean).slice(0, 3);
  if (list.length) await applyOps([{ op: "dictSet", store: "meaningsDict", key: word, value: list }]);
  return { list };
}

/* kelimenin cümledeki kullanımını açıkla (kaydedilmez) */
async function opExplain(word, sentence, domainLabel) {
  const r = await ollamaGenerate(
    `Alan: ${domainLabel || "genel"}.\nİngilizce cümle: "${sentence}"\nKelime: "${word}"\n` +
    `Bu kelimeyi bu cümledeki kullanımına göre 1-2 cümleyle Türkçe açıkla; gerekiyorsa çevirme, teknik terimi koru. Kısa ve net ol.`,
    { system: "Sen teknik metinler için Türkçe açıklama yazan bir çeviri asistanısın. Yalnızca açıklamayı yazarsın." });
  if (r.raw === undefined) return failOf(r);
  return r.raw ? { t: r.raw } : { error: "boş yanıt" };
}

/* okuyucudaki toplu kelime çevirisi → [{w,t}] ve kalıcı sözlüğe yazım */
async function opWordBatch(words, domainLabel) {
  const list = (Array.isArray(words) ? words : []).slice(0, 40);
  if (!list.length) return { items: [] };
  const r = await ollamaGenerate(
    "Aşağıdaki İngilizce kelimeleri " + (domainLabel || "genel") +
    " bağlamında Türkçeye çevir. Kurallar: her kelime için en fazla 3 kelimelik kısa karşılık; " +
    "teknik terimi gerekiyorsa aynen bırak. YALNIZCA {\"kelimeler\":[{\"w\":\"kelime\",\"t\":\"karşılık\"},...]} JSON nesnesi döndür.\n\n" +
    "Kelimeler: " + list.join(", "),
    { system: TR_SYS, format: SCHEMA.wordBatch, timeoutMs: 120000, priority: PRI.batch });
  if (r.raw === undefined) return failOf(r);
  const o = parseJson(r.raw, "object");
  const arr = Array.isArray(o) ? o : (o && Array.isArray(o.kelimeler) ? o.kelimeler : []);
  const want = new Set(list.map((w) => w.toLowerCase()));
  const items = arr
    .map((it) => ({ w: unquote(it && it.w).toLowerCase(), t: unquote(it && it.t) }))
    .filter((it) => it.w && it.t && it.t.length <= 60 && want.has(it.w));
  await applyOps(items.map((it) => ({ op: "dictSet", store: "userDict", key: it.w, value: it.t })));
  return { items };
}

async function opPing(timeoutMs) {
  const { url } = await getSettings();
  try {
    const r = await fetch(url + "/api/tags", { signal: AbortSignal.timeout(timeoutMs || 2500) });
    if (r.ok) ollamaDownUntil = 0;
    return { ok: r.ok };
  } catch (e) { return { ok: false }; }
}

/* ---- günlük istatistik + rozet sayacı ----
   dailyStats: { "2026-10-19": { translated: 12 } } — 90 gün saklanır, gün anahtarı yerel saat */
function bumpDaily() {
  return withStore(async () => {
    const day = dayKey();
    const st = await chrome.storage.local.get(["dailyStats", "settings"]);
    const ds = st.dailyStats || {};
    ds[day] = ds[day] || { translated: 0 };
    ds[day].translated++;
    const days = Object.keys(ds).sort();
    while (days.length > 90) delete ds[days.shift()];      // eski günleri buda
    await chrome.storage.local.set({ dailyStats: ds });
    const hoverOn = !st.settings || st.settings.hoverEnabled !== false;
    chrome.action.setBadgeText({ text: hoverOn ? String(ds[day].translated) : "⏸" });
  });
}

/* ---- cümle odaklı analiz: cümle çevirisi + her kelimenin O cümledeki anlamı (tek istek) ----
   targets: [{w, c:[aday anlamlar]}] · terms: [{w, t}] alan sözlüğü ipuçları · focus: imlecin altındaki kelime.
   Sonuç ctxDict[cümle]'ye birleşir; cümle çevirisi sentenceDict'e, anlamlar kelime katmanına (userDict/meaningsDict) gider. */
const ANALYZE_EXAMPLE =
  'Örnek → Cümle: "We sat on the river bank and watched the boats." Kelimeler: bank (adaylar: banka | nehir kıyısı), watched (adaylar: izlemek | saat)\n' +
  '{"ceviri":"Nehir kıyısında oturup tekneleri izledik.","kelimeler":[{"kelime":"bank","kok":"bank","anlam":"nehir kıyısı",' +
  '"karsilik":"Nehir kıyısında"},{"kelime":"watched","kok":"watch","anlam":"izlemek","karsilik":"izledik"}],' +
  '"aciklama":"river ile birlikte geçtiği için bank burada para kurumu değil, nehir kenarı anlamında."}';

/* modelin işaretlediği karşılık anlamla örtüşmüyorsa çeviride anlamın kökünü ara
   (ör. ephemeral: anlam "geçici", karşılık yanlışlıkla "iş yüklerini" → "geçici") */
function fixKarsilik(tr, a, k) {
  const low = (x) => String(x || "").toLocaleLowerCase("tr");
  const T = low(tr);
  const roots = low(a).split(/[\s,;/()]+/).filter((x) => x.length >= 4).map((x) => x.slice(0, 4));
  const ok = k && T.includes(low(k));
  if (ok && (!roots.length || roots.some((r) => low(k).includes(r)))) return k;
  const trWords = String(tr).match(/[\p{L}'’-]+/gu) || [];
  for (const r of roots) {
    const hit = trWords.find((w) => low(w).startsWith(r));
    if (hit) return hit;
  }
  return ok ? k : "";
}

async function opAnalyze(sentence, targets, focus, terms, domainLabel, group, { prefetch = false } = {}) {
  sentence = String(sentence || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const list = (Array.isArray(targets) ? targets : [])
    .map((x) => ({ w: String(x && x.w || "").toLowerCase().slice(0, 40),
      c: (Array.isArray(x && x.c) ? x.c : []).map((v) => String(v).slice(0, 40)).filter(Boolean).slice(0, 4) }))
    .filter((x) => x.w).slice(0, 12);
  focus = String(focus || "").toLowerCase();
  if (!sentence || !list.length) return { error: "boş istek" };

  const prompt =
    `Alan: ${domainLabel || "genel"}\n` +
    `Cümle: "${sentence}"\n` +
    termLine(terms) +
    `Kelimeler:\n` + list.map((x) => `- ${x.w}` + (x.c.length ? ` (adaylar: ${x.c.join(" | ")})` : "")).join("\n") + "\n" +
    `Görev:\n` +
    `1) "ceviri": cümlenin doğal, akıcı Türkçe çevirisi.\n` +
    `2) "kelimeler": listedeki HER kelime için bir öğe. "anlam": kelimenin BU cümledeki Türkçe anlamı (en fazla 4 kelime; ` +
    `adaylardan uyan varsa onu aynen seç, hiçbiri uymuyorsa kendin yaz). "kok": kelimenin sözlük biçimi (mitigates → mitigate). ` +
    `"karsilik": senin "ceviri" metninde bu kelimeye denk gelen kısım, metinde geçtiği gibi.\n` +
    `3) "aciklama": "${focus || list[0].w}" kelimesinin bu cümlede neden bu anlama geldiğini anlatan 1 kısa Türkçe cümle.\n` +
    `Teknik terimi gerekiyorsa İngilizce bırakabilirsin.\n` + ANALYZE_EXAMPLE;

  const r = await ollamaGenerate(prompt, {
    system: TR_SYS, format: SCHEMA.analyze, group, temperature: 0,
    timeoutMs: prefetch ? 180000 : 60000,          // kuyrukta beklerken öne alınabilir
    priority: prefetch ? PRI.prefetch : PRI.interactive,
    key: "ctx:" + sentence
  });
  if (r.raw === undefined) return failOf(r);
  const o = parseJson(r.raw, "object");
  const tr = o && unquote(o.ceviri);
  if (!tr || looksLikeMeta(tr, sentence)) return { error: "geçersiz yanıt" };

  const wanted = new Set(list.map((x) => x.w));
  const words = {};
  for (const it of (Array.isArray(o.kelimeler) ? o.kelimeler : [])) {
    const w = String(it && it.kelime || "").toLowerCase().trim();
    const a = unquote(it && it.anlam);
    if (!wanted.has(w) || !a || a.length > 60 || looksLikeMeta(a, w)) continue;
    const k = unquote(it.karsilik);
    const l = String(it.kok || "").toLowerCase().trim();
    words[w] = {
      a,
      k: fixKarsilik(tr, a, k),
      l: /^[a-z][a-z'-]{1,39}$/.test(l) && l !== w ? l : ""
    };
  }
  if (focus && words[focus] && o.aciklama) {
    const n = unquote(o.aciklama);
    if (n && !looksLikeMeta(n, sentence)) words[focus].n = n.slice(0, 300);
  }
  if (!Object.keys(words).length) return { error: "geçersiz yanıt" };

  const ops = [
    { op: "ctxMerge", key: sentence, value: { tr, w: words } },
    { op: "dictSet", store: "sentenceDict", key: sentence, value: tr },
    ...Object.entries(words).map(([w, v]) => ({ op: "senseAdd", w, a: v.a }))
  ];
  await applyOps(ops);
  if (!prefetch) bumpDaily();                        // günlük sayaç yalnız kullanıcının baktığı kelimeler
  const st = await chrome.storage.local.get("ctxDict");
  return { entry: (st.ctxDict || {})[sentence] || { tr, w: words } };
}

/* ---- mesaj yönlendirici ----
   krh-promote:        { sentence } -> { ok }   ·   krh-bg-cancel: {} -> { ok }
   krh-analyze:        { prefetch?, sentence, targets:[{w,c}], focus, terms:[{w,t}], domainLabel } -> { entry:{tr, w:{kelime:{a,k,l,n}}} } | { down } | { cancelled } | { error }
   krh-translate:      { word, sentence, domainLabel } -> { t, other, note } | { down } | { cancelled } | { error }
   krh-sentence:       { sentence }                    -> { t } | ...
   krh-sentence-batch: { sentences, whole?, batch? }   -> { arr } | ...
   krh-ollama:         { op: ping|wordShort|meanings|explain|wordBatch, ... }
   krh-mutate:         { ops }                         -> { ok }
   krh-cleanup:        {}                              -> temizlik istatistiği */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("krh-")) return;
  const tabGroup = "hover:" + (sender.tab ? sender.tab.id : "x") + ":" + (sender.frameId || 0);
  (async () => {
    switch (msg.type) {
      case "krh-mutate": return applyOps(msg.ops);
      case "krh-cleanup": return withStore(() => cleanupTranslations(true));
      case "krh-translate":
        dropQueued(tabGroup);   // imleç yeni kelimede: aynı sekmenin bekleyen eski istekleri düşer
        return opWord(String(msg.word || ""), msg.sentence, msg.domainLabel, tabGroup);
      case "krh-analyze":
        if (msg.prefetch) {
          return opAnalyze(msg.sentence, msg.targets, msg.focus, msg.terms, msg.domainLabel,
            "bg" + tabGroup.slice(5), { prefetch: true });
        }
        dropQueued(tabGroup);   // imleç başka cümleye/kelimeye geçti: bekleyen eski istekler düşer
        return opAnalyze(msg.sentence, msg.targets, msg.focus, msg.terms, msg.domainLabel, tabGroup);
      case "krh-promote":       // kullanıcı ön çevirisi bekleyen cümleye geldi
        return { ok: promote("ctx:" + String(msg.sentence || "").replace(/\s+/g, " ").trim().slice(0, 300)) };
      case "krh-bg-cancel":     // sekme gizlendi / ön çeviri kapatıldı
        dropQueued("bg" + tabGroup.slice(5));
        return { ok: true };
      case "krh-sentence": return opSentence(String(msg.sentence || ""), { terms: msg.terms });
      case "krh-sentence-batch":
        return opSentenceBatch(msg.sentences, { whole: msg.whole, terms: msg.terms, priority: msg.batch ? PRI.batch : PRI.interactive });
      case "krh-ollama":
        switch (msg.op) {
          case "ping": return opPing(msg.timeoutMs);
          case "wordShort": return opWordShort(String(msg.word || ""), msg.domainLabel);
          case "meanings": return opMeanings(String(msg.word || ""));
          case "explain": return opExplain(String(msg.word || ""), String(msg.sentence || ""), msg.domainLabel);
          case "wordBatch": return opWordBatch(msg.words, msg.domainLabel);
        }
        return { error: "bilinmeyen işlem" };
    }
    return undefined;
  })().then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;   // async sendResponse
});
