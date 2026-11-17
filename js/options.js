let settings = { ollamaUrl: "http://localhost:11434", model: "llama3.1", hoverEnabled: true, domain: "devops" };
let userDict = {}, meaningsDict = {}, explainDict = {};   // hover ile çevrilen kelimeler
let known = new Set(), learning = new Set();              // kelime durumları
let srsData = {};                                         // kelime -> { l: seviye 0-4, due: zaman }
let dailyStats = {};                                      // gün -> { translated }
let contextLog = {};                                      // kelime -> [{s, h, t}] bağlam geçmişi
let statusFilter = "all";                                 // all | known | learning | unknown

const $ = (s) => document.querySelector(s);

init();
async function init() {
  const st = await chrome.storage.local.get(
    ["settings", "userDict", "meaningsDict", "explainDict", "knownWords", "learningWords", "srsData", "dailyStats", "contextLog"]);
  if (st.settings) settings = { ...settings, ...st.settings };
  userDict = st.userDict || {};
  meaningsDict = st.meaningsDict || {};
  explainDict = st.explainDict || {};
  known = new Set(st.knownWords || []);
  learning = new Set(st.learningWords || []);
  srsData = st.srsData || {};
  dailyStats = st.dailyStats || {};
  contextLog = st.contextLog || {};
  $("#ollamaUrl").value = settings.ollamaUrl;
  $("#model").value = settings.model;
  $("#hoverEnabled").checked = settings.hoverEnabled !== false;
  $("#highlightEnabled").checked = settings.highlightEnabled !== false;
  $("#autoTranslate").checked = settings.autoTranslate !== false;
  $("#defDomain").value = settings.domain || "devops";
  renderWordTable();
  renderStats();
  renderQuiz();

  $("#btnSave").addEventListener("click", save);
  $("#btnReset").addEventListener("click", async () => {
    await chrome.storage.local.clear();
    location.reload();
  });
  $("#hoverEnabled").addEventListener("change", save);   // anahtar: tıklar tıklamaz kaydet
  $("#highlightEnabled").addEventListener("change", save);
  $("#autoTranslate").addEventListener("change", save);
  $("#defDomain").addEventListener("change", save);
  $("#btnCleanup").addEventListener("click", runCleanup);
  $("#wordFilter").addEventListener("input", renderWordTable);
  // durum sekmeleri
  document.querySelectorAll("#statusTabs button").forEach((b) =>
    b.addEventListener("click", () => {
      statusFilter = b.dataset.f;
      document.querySelectorAll("#statusTabs button").forEach((x) =>
        x.classList.toggle("on", x === b));
      renderWordTable();
    }));
  // başka sekmede (hover) yeni kelime çevrilirse tabloyu canlı tazele
  chrome.storage.onChanged.addListener((chg, area) => {
    if (area !== "local") return;
    if (chg.userDict) userDict = chg.userDict.newValue || {};
    if (chg.meaningsDict) meaningsDict = chg.meaningsDict.newValue || {};
    if (chg.explainDict) explainDict = chg.explainDict.newValue || {};
    if (chg.knownWords) known = new Set(chg.knownWords.newValue || []);
    if (chg.learningWords) learning = new Set(chg.learningWords.newValue || []);
    if (chg.userDict || chg.meaningsDict || chg.explainDict || chg.knownWords || chg.learningWords)
      renderWordTable();
  });
}

/* ---- çevrilen kelimeler tablosu (userDict + meaningsDict + explainDict) ---- */
/* ---- çevrilen kelimeler tablosu: sayfalı yükleme (batch + loader) ---- */
const WORD_BATCH = 50;
let filteredWords = [];     // aktif filtreye uyan kelimeler
let wordCursor = 0;         // kaçıncı kelimeye kadar yüklendi
let wordLoading = false;

/* kelimenin durumu: known | learning | unknown */
function wordStatus(w) {
  return known.has(w) ? "known" : learning.has(w) ? "learning" : "unknown";
}

function renderWordTable() {
  const tb = $("#wordTable tbody");
  const filter = ($("#wordFilter").value || "").trim().toLowerCase();
  tb.innerHTML = "";
  const words = Object.keys(userDict).sort();
  // sekme sayaçları (metin filtresinden bağımsız, duruma göre)
  const counts = { all: words.length, known: 0, learning: 0, unknown: 0 };
  for (const w of words) counts[wordStatus(w)]++;
  for (const k of Object.keys(counts)) {
    const el = document.querySelector('[data-c="' + k + '"]');
    if (el) el.textContent = counts[k] ? "(" + counts[k] + ")" : "";
  }
  filteredWords = words.filter((w) =>
    (statusFilter === "all" || wordStatus(w) === statusFilter) &&
    (!filter || w.includes(filter)));
  wordCursor = 0;
  $("#wordCount").textContent = words.length
    ? "(" + (filteredWords.length !== words.length
        ? filteredWords.length + "/" + words.length
        : words.length) + " kelime)"
    : "";
  $("#wordEmpty").style.display = words.length ? "none" : "";
  loadMoreWords();
}

/* sonraki grubu loader göstererek yükle; kalan varsa "daha fazla" butonu bırak */
function loadMoreWords() {
  if (wordLoading) return;
  wordLoading = true;
  const tb = $("#wordTable tbody");
  const loader = document.createElement("tr");
  loader.className = "loader-row";
  loader.innerHTML = '<td colspan="5"><span class="spin"></span> yükleniyor…</td>';
  tb.appendChild(loader);

  // loader'ın boyanması için bir kare bekle, sonra grubu işle
  setTimeout(() => {
    loader.remove();
    const end = Math.min(wordCursor + WORD_BATCH, filteredWords.length);
    for (; wordCursor < end; wordCursor++) {
      tb.appendChild(wordRow(filteredWords[wordCursor]));
    }
    const remaining = filteredWords.length - wordCursor;
    if (remaining > 0) {
      const more = document.createElement("tr");
      more.className = "more-row";
      const td = document.createElement("td");
      td.colSpan = 5;
      const btn = document.createElement("button");
      btn.className = "ghost more-btn";
      btn.textContent = "↓ Daha fazla göster (" + remaining + " kaldı)";
      btn.addEventListener("click", () => { more.remove(); loadMoreWords(); });
      td.appendChild(btn);
      more.appendChild(td);
      tb.appendChild(more);
    }
    wordLoading = false;
  }, 40);
}

function wordRow(w) {
  const others = (meaningsDict[w] || []).join(", ");
  const note = explainDict[w] || "";
  const tr = document.createElement("tr");
  const tdW = document.createElement("td");
  const dot = document.createElement("span");
  dot.className = "dot " + wordStatus(w);
  dot.title = { known: "✓ Biliyorum", learning: "📖 Öğreniyorum", unknown: "○ Bilinmiyor" }[wordStatus(w)];
  const b = document.createElement("b"); b.textContent = w;
  tdW.append(dot, b);
  // bağlam geçmişi: kelime hücresinin üzerine gelince görüldüğü cümleler
  const ctxs = contextLog[w] || [];
  if (ctxs.length) {
    tdW.title = "📌 " + ctxs.length + " kez görüldü:\n" +
      ctxs.map((c) => "• " + c.s + " (" + c.h + ")").join("\n");
  }
  const tdM = document.createElement("td"); tdM.textContent = userDict[w];
  const tdO = document.createElement("td"); tdO.textContent = others;
  const tdN = document.createElement("td"); tdN.textContent = note;
  tdN.className = "muted"; tdN.style.fontSize = "12px";
  const tdD = document.createElement("td");
  const del = document.createElement("button");
  del.className = "del"; del.title = "Sil"; del.textContent = "✕";
  del.addEventListener("click", () => deleteWord(w));
  tdD.appendChild(del);
  tr.append(tdW, tdM, tdO, tdN, tdD);
  return tr;
}

async function deleteWord(w) {
  delete userDict[w];
  delete meaningsDict[w];
  delete explainDict[w];
  await KRStore.deleteWord(w);   // tek yazma noktası (background)
  renderWordTable();
}

/* çeviri deposunu tek şemaya uydur (background'daki temizleyiciyi çağırır) */
async function runCleanup() {
  const out = $("#cleanupResult"), btn = $("#btnCleanup");
  btn.disabled = true;
  out.textContent = "temizleniyor…";
  try {
    const r = await chrome.runtime.sendMessage({ type: "krh-cleanup" });
    if (!r) out.textContent = "⚠️ yanıt alınamadı";
    else if (r.skipped) out.textContent = "✓ depo zaten güncel şemada";
    else out.textContent = `✓ ${r.total} kayıt tarandı · ${r.kept} korundu · ${r.fixed} onarıldı · ${r.dropped} silindi`;
  } catch (e) {
    out.textContent = "⚠️ " + (e.message || e);
  } finally {
    btn.disabled = false;
    setTimeout(() => { out.textContent = ""; }, 8000);
  }
}

async function save() {
  settings.ollamaUrl = $("#ollamaUrl").value.trim() || "http://localhost:11434";
  settings.model = $("#model").value.trim() || "llama3.1";
  settings.hoverEnabled = $("#hoverEnabled").checked;
  settings.highlightEnabled = $("#highlightEnabled").checked;
  settings.autoTranslate = $("#autoTranslate").checked;
  settings.domain = $("#defDomain").value || "devops";
  await chrome.storage.local.set({ settings });
  const s = $("#saved");
  s.style.visibility = "visible";
  setTimeout(() => (s.style.visibility = "hidden"), 1500);
}

/* ---- 📊 istatistik satırı: bugün + seri + toplam ---- */
function renderStats() {
  const day = krDayKey();
  const today = dailyStats[day]?.translated || 0;
  // seri: bugünden (veya dünden) geriye doğru arka arkaya aktif günler
  let streak = 0;
  const d = new Date();
  if (!dailyStats[krDayKey(d)]?.translated) d.setDate(d.getDate() - 1);
  while (dailyStats[krDayKey(d)]?.translated > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  const parts = [];
  if (today) parts.push("Bugün " + today + " çeviri");
  if (streak > 1) parts.push("🔥 " + streak + " günlük seri");
  if (known.size) parts.push("✓ " + known.size + " bilinen");
  if (learning.size) parts.push("📖 " + learning.size + " öğrenilen");
  $("#statsLine").textContent = parts.join(" · ");
}

/* ---- 🧠 SRS mini quiz: "öğreniyorum" kelimeleri aralıklı tekrar ---- */
const SRS_MIN = [10, 720, 2880, 7200, 21600];   // 10dk, 12sa, 2g, 5g, 15g
let dueWords = [], quizWord = null;

function dueList() {
  const now = Date.now();
  return [...learning].filter((w) => !srsData[w] || srsData[w].due <= now);
}

function renderQuiz() {
  dueWords = dueList();
  $("#srsInfo").textContent = dueWords.length
    ? "(" + dueWords.length + " kelime tekrar bekliyor)"
    : learning.size ? "(şu an bekleyen yok)" : "(önce 📖 ile kelime ekle)";
  const box = $("#quizBox");
  if (!dueWords.length) {
    box.style.display = "none";
    return;
  }
  box.style.display = "";
  quizWord = dueWords[0];
  $("#qWord").textContent = quizWord;
  $("#qAnswer").style.display = "none";
  $("#qNote").style.display = "none";
  $("#qShow").style.display = "";
  $("#qKnow").style.display = "none";
  $("#qMiss").style.display = "none";
  const lvl = srsData[quizWord]?.l || 0;
  $("#qNote").textContent = "seviye " + lvl + "/4";

  $("#qShow").onclick = () => {
    const w = quizWord;
    $("#qAnswer").textContent = "→ " + (userDict[w] || DICTIONARY[w] || "(çevirisi yok)");
    const others = (meaningsDict[w] || []).join(", ");
    const note = explainDict[w] || "";
    $("#qNote").textContent = [others && "diğer: " + others, note].filter(Boolean).join(" — ") || "seviye " + lvl + "/4";
    $("#qAnswer").style.display = "";
    $("#qNote").style.display = "";
    $("#qShow").style.display = "none";
    $("#qKnow").style.display = "";
    $("#qMiss").style.display = "";
  };
  $("#qKnow").onclick = () => answerQuiz(true);
  $("#qMiss").onclick = () => answerQuiz(false);
}

async function answerQuiz(gotIt) {
  const w = quizWord;
  const cur = srsData[w] || { l: 0, due: 0 };
  if (gotIt) {
    cur.l = Math.min(4, cur.l + 1);
    cur.due = Date.now() + SRS_MIN[cur.l] * 60000;
    if (cur.l >= 4) {
      // mezuniyet: biliyorum'a terfi
      learning.delete(w);
      known.add(w);
      delete srsData[w];
      await KRStore.setState(w, "known");
      await chrome.storage.local.set({ srsData });
      renderWordTable();
      renderStats();
      renderQuiz();
      return;
    }
  } else {
    cur.l = 0;
    cur.due = Date.now() + SRS_MIN[0] * 60000;
  }
  srsData[w] = cur;
  await chrome.storage.local.set({ srsData });
  renderQuiz();
}
