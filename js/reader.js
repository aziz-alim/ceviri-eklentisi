/* Çeviri Eklentisi — Tam ekran okuma modu + yerel seslendirme (TTS) */
const $ = (s) => document.querySelector(s);
const reader = $("#reader");

let customGlossary = {};
let article = null;
let paragraphs = [];            // {spans:[], offsets:[], sentIds:[]}
let settings = { domain: "devops", ollamaUrl: "http://localhost:11434", model: "llama3.1" };

/* ---- seslendirme durumu ---- */
const synth = window.speechSynthesis;
let voices = [];
let voiceList = [];
let curP = -1;                  // okunan paragraf
let lastW = 0;                  // son okunan kelime indeksi
let followMode = true;          // okunan kelimeyi takip et
let uttToken = 0;               // konuşma iptal jetonu

init();
async function init() {
  await KR.loadKnown();
  const st = await chrome.storage.local.get(["settings", "customGlossary", "fullscreenArticle"]);
  if (st.settings) settings = { ...settings, ...st.settings };
  if (st.customGlossary) customGlossary = st.customGlossary;
  article = st.fullscreenArticle;
  $("#domain").value = settings.domain;

  // detay çekmecesi (ortak çekirdek) — kelimeye tıklayınca ayrıca tek başına seslendir
  KR.initDetail({ getSettings: () => settings, getCustom: () => customGlossary, onWordClick: speakWord });
  KR.initStatsDrawer({
    getReader: () => reader,
    version: "v" + chrome.runtime.getManifest().version
  });
  $("#btnMenu").addEventListener("click", () => KR.toggleStatsDrawer());

  $("#domain").addEventListener("change", () => {
    settings.domain = $("#domain").value;
    chrome.storage.local.set({ settings });
    stopSpeech();
    if (article) renderArticle(article);
  });
  $("#btnClose").addEventListener("click", () => window.close());
  $("#btnPlay").addEventListener("click", togglePlay);
  $("#btnStop").addEventListener("click", () => { stopSpeech(); });

  loadVoices();
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  $("#voice").addEventListener("change", () => {
    const v = voiceList[+$("#voice").value];
    if (v) { settings.voiceName = v.name; chrome.storage.local.set({ settings }); }
  });

  if (!article) {
    reader.innerHTML = '<p style="color:var(--muted);text-align:center;margin-top:120px;font-size:20px">' +
      'Makale bulunamadı. Yan panelden "Sayfayı okuma moduna al" butonunu kullan.</p>';
    return;
  }
  renderArticle(article);
}

/* ---- ses listesi ---- */
function qualityRank(v) {
  // kaliteli/doğal sesleri öne koy
  return /siri|neural|natural|premium|enhanced|google/i.test(v.name) ? 0 : 1;
}

function loadVoices() {
  const all = synth.getVoices();
  voices = all;
  let en = all.filter(v => v.lang.replace("_", "-").toLowerCase().startsWith("en"));
  if (!en.length) en = all.slice();
  en.sort((a, b) => qualityRank(a) - qualityRank(b) || a.name.localeCompare(b.name));
  voiceList = en;

  const sel = $("#voice");
  sel.innerHTML = "";
  en.forEach((v, i) => {
    const o = document.createElement("option");
    o.value = i;   // voiceList indeksi — voices dizisi ile karışmaz
    o.textContent = v.name.replace(/Microsoft |Google /, "").slice(0, 26) + " · " + v.lang;
    sel.appendChild(o);
  });

  // kayıtlı seçim varsa onu, yoksa en kaliteli en-US sesini seç
  const savedIdx = settings.voiceName ? en.findIndex(v => v.name === settings.voiceName) : -1;
  const bestIdx = en.findIndex(v => v.lang === "en-US" && qualityRank(v) === 0);
  sel.value = savedIdx >= 0 ? savedIdx : (bestIdx >= 0 ? bestIdx : 0);
}

/* ---- makaleyi ortak çekirdekle render et ---- */
function renderArticle(art) {
  stopSpeech();
  paragraphs = KR.renderArticle(art, reader, settings, customGlossary, (span) => KR.openDetail(span));
  const total = reader.querySelectorAll(".w").length;
  const ready = reader.querySelectorAll(".w[data-meaning]").length;
  KR.toast("⚡ " + total + " kelime işlendi — " + ready + " tanesinin anlamı hazır");
  setTimeout(backfillUnknown, 600);       // anlamı olmayan kelimeleri Ollama ile çevirip sözlüğe kaydet
  setTimeout(() => KR.backfillSentences(reader, settings), 900);   // cümleleri otomatik çevir
  KR.refreshStats();
}

/* Ollama varsa, sözlükte olmayan kelimeleri toplu çevirip kullanıcı sözlüğüne kaydet */
async function backfillUnknown() {
  if (!(await KR.ollama.ping(settings, 2500))) return;

  const uniq = [...new Set([...reader.querySelectorAll(".w[data-word]")].map(s => s.dataset.word.toLowerCase()))];
  const missing = uniq.filter(w => w.length > 1 && !KR.hasMeaning(w, settings, customGlossary));
  if (!missing.length) return;

  KR.toast("🔄 " + missing.length + " bilinmeyen kelime Ollama ile çevriliyor…");
  const CHUNK = 20;
  let done = 0;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    try {
      const arr = await KR.ollama.translateBatch(settings, chunk, DOMAIN_LABELS[settings.domain]);
      for (const it of arr) {
        if (it && it.w && it.t) KR.userDict[String(it.w).toLowerCase()] = String(it.t).trim();
      }
      await KR.saveUserDict();
      reader.querySelectorAll(".w").forEach(s => {
        if (s.dataset.word && chunk.includes(s.dataset.word.toLowerCase())) {
          KR.decorateSpan(s, s.dataset.word, settings, customGlossary);
        }
      });
    } catch (e) { return; }
    done += chunk.length;
    KR.toast("⚡ " + Math.min(done, missing.length) + "/" + missing.length + " kelime çevrildi ve sözlüğe kaydedildi");
  }
}

/* ---- seslendirme ---- */
function togglePlay() {
  if (synth.speaking) { pauseAtPosition(); return; }
  // devam: kayıtlı pozisyondan (yoksa baştan)
  if (curP >= 0 && curP < paragraphs.length) startFrom(curP, lastW);
  else startFrom(0, 0);
}

/* duraklat: motoru durdur, pozisyonu SAKLA — devam aynı kelimeden */
function pauseAtPosition() {
  uttToken++;
  synth.cancel();
  setPlayIdle();
}

/* tıklanan kelimeyi TEK başına oku; ▶ bu kelimeden devam etsin */
function speakWord(span) {
  const p = +span.dataset.pidx, w = +span.dataset.widx;
  if (Number.isNaN(p) || !paragraphs[p]) return;
  curP = p;
  lastW = Number.isNaN(w) ? 0 : w;
  const myToken = ++uttToken;
  synth.cancel();
  clearHighlights();
  const u = new SpeechSynthesisUtterance(span.dataset.word);
  const v = voiceList[+$("#voice").value];
  if (v) u.voice = v;
  u.rate = +$("#rate").value;
  span.classList.add("speaking");
  const cleanup = () => { if (myToken === uttToken) { span.classList.remove("speaking"); setPlayIdle(); } };
  u.onend = cleanup;
  u.onerror = cleanup;
  $("#btnPlay").textContent = "⏸";
  synth.speak(u);
}

function wordIndexAt(para, charIndex) {
  let lo = 0, hi = para.offsets.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (para.offsets[mid] <= charIndex) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

function startFrom(pIdx, wIdx) {
  synth.cancel();
  curP = pIdx; lastW = wIdx;
  const myToken = ++uttToken;
  if (curP >= paragraphs.length) { clearHighlights(); setPlayIdle(); return; }
  const para = paragraphs[curP];
  if (wIdx >= para.spans.length) { startFrom(pIdx + 1, 0); return; }
  const baseOffset = wIdx > 0 ? para.offsets[wIdx] : 0;
  const text = para.spans.slice(wIdx).map(s => s.textContent).join(" ");

  const u = new SpeechSynthesisUtterance(text);
  const v = voiceList[+$("#voice").value];
  if (v) u.voice = v;
  u.rate = +$("#rate").value;

  u.onboundary = (e) => {
    if (e.name && e.name !== "word") return;
    lastW = wIdx + wordIndexAt(para, baseOffset + e.charIndex);
    highlightAt(para, baseOffset + e.charIndex);
  };
  u.onend = () => {
    if (myToken !== uttToken) return;
    clearHighlights();
    startFrom(pIdx + 1, 0);   // sonraki paragrafa zincirle
  };
  u.onerror = () => { if (myToken === uttToken) setPlayIdle(); };

  $("#btnPlay").textContent = "⏸";
  synth.speak(u);
}

function stopSpeech() {
  uttToken++;
  synth.cancel();
  curP = -1; lastW = 0;
  clearHighlights();
  setPlayIdle();
}
function setPlayIdle() { $("#btnPlay").textContent = "▶"; }

function highlightAt(para, charIndex) {
  const span = para.spans[wordIndexAt(para, charIndex)];
  if (!span) return;
  clearHighlights();
  const sid = span.dataset.sid;
  reader.querySelectorAll(`.w[data-sid="${sid}"]`).forEach(w => w.classList.add("sent-on"));
  span.classList.add("speaking");
  if (followMode) span.scrollIntoView({ block: "center", behavior: "smooth" });
}
function clearHighlights() {
  reader.querySelectorAll(".w.speaking,.w.sent-on").forEach(w => w.classList.remove("speaking", "sent-on"));
}
