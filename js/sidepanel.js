/* Çeviri Eklentisi — yan panel mantığı */
const $ = (s) => document.querySelector(s);
const reader = $("#reader"), statusEl = $("#status"), libraryEl = $("#library");

let customGlossary = {};
let settings = { domain: "devops", ollamaUrl: "http://localhost:11434", model: "llama3.1" };

init();
async function init() {
  await KR.loadKnown();
  const st = await chrome.storage.local.get(["settings", "customGlossary"]);
  if (st.settings) settings = { ...settings, ...st.settings };
  $("#domain").value = settings.domain;
  if (st.customGlossary) customGlossary = st.customGlossary;

  KR.initDetail({ getSettings: () => settings, getCustom: () => customGlossary });
  KR.initStatsDrawer({
    getReader: () => reader,
    onLibrary: () => toggleLibrary(true),
    version: "v" + chrome.runtime.getManifest().version
  });
  $("#btnMenu").addEventListener("click", () => KR.toggleStatsDrawer());

  $("#domain").addEventListener("change", () => {
    settings.domain = $("#domain").value;
    chrome.storage.local.set({ settings });
    if (reader.dataset.loaded) renderArticle(JSON.parse(reader.dataset.article));
  });
  $("#btnExtract").addEventListener("click", extractArticle);
  $("#btnLibrary").addEventListener("click", () => toggleLibrary());
  $("#btnOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
}

function setStatus(msg, cls = "") {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

/* ---- Sayfa metnini çıkar (aktif sekmede çalıştırılır) ---- */
async function extractArticle() {
  setStatus("Sayfa analiz ediliyor…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setStatus("Aktif sekme bulunamadı.", "err");
      return;
    }
    if (tab.url && !/^https?:/.test(tab.url)) {
      setStatus("Bu sayfa tipi desteklenmiyor (chrome://, PDF vb.); bir makale sayfası aç.", "err");
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent
    });
    const article = results?.[0]?.result;
    if (!article || !article.paragraphs?.length) {
      setStatus("Sayfada okunabilir metin bulunamadı.", "err");
      return;
    }
    renderArticle(article);
    setStatus(`✓ ${article.paragraphs.length} paragraf yüklendi. Tam ekran okuyucu açılıyor…`, "ok");
    await saveToLibrary(article, tab.url || "");
    await chrome.storage.local.set({ fullscreenArticle: article });
    await chrome.tabs.create({ url: chrome.runtime.getURL("reader.html") });
  } catch (e) {
    setStatus("Hata: " + e.message, "err");
  }
}

/* Sayfa içinde çalışan Readability benzeri basit çıkarıcı.
   Klon üzerinde çalışır — orijinal sayfaya DOKUNMAZ.
   Paragraflarla birlikte anlamlı görselleri de, sayfadaki sıralarını koruyarak çıkarır. */
function extractPageContent() {
  const kill = "script,style,nav,header,footer,aside,form,iframe,noscript,blockquote";
  const clone = document.body.cloneNode(true);
  kill.split(",").forEach((s) => clone.querySelectorAll(s).forEach((n) => n.remove()));
  const score = (el) => {
    const t = el.textContent.trim();
    if (t.length < 80) return -1;
    let sc = t.length;
    if (/^(p|article|section|main|div|li|h1|h2|h3)$/.test(el.tagName.toLowerCase())) sc *= 1.2;
    const links = el.querySelectorAll("a").length;
    sc *= Math.max(0.2, 1 - links / Math.max(1, t.split(/\s+/).length));
    return sc;
  };
  let best = null, bestScore = 0;
  clone.querySelectorAll("article, main, .post, .content, .entry, [role=main], body").forEach((el) => {
    const sc = score(el);
    if (sc > bestScore) { bestScore = sc; best = el; }
  });
  if (!best) return null;
  const title = document.querySelector("h1")?.textContent.trim() || document.title;

  // kötü görsel: logo/ikon/avatar/piksel ölçer; küçük buton görselleri
  const BAD_IMG = /logo|icon|avatar|spacer|pixel|sprite|badge|btn|button|advert|banner|tracking|1x1|emoji/i;
  const isBadImg = (im, src) => {
    if (!src || BAD_IMG.test(src)) return true;
    if (src.startsWith("data:")) return src.length > 100000;   // devasa data-URI'yi at
    const w = +im.getAttribute("width") || 0, h = +im.getAttribute("height") || 0;
    if (w && h && (w < 200 || h < 120)) return true;           // ölçüsü belli küçük görsel
    return false;
  };

  const paras = [];
  const seen = new Set();
  const seenImg = new Set();
  let imgCount = 0;
  const MAX_IMG = 30;
  // belge sırası korunur: görsel, metindeki yerine denk düşen aralıkta çıkar
  best.querySelectorAll("p, li, h2, h3, h4, pre, figcaption, img").forEach((el) => {
    if (el.tagName === "IMG") {
      const src = el.src || el.getAttribute("src") || "";
      if (imgCount >= MAX_IMG || seenImg.has(src) || isBadImg(el, src)) return;
      seenImg.add(src);
      imgCount++;
      paras.push({ img: src, alt: (el.getAttribute("alt") || "").trim() });
      return;
    }
    const t = el.textContent.replace(/\s+/g, " ").trim();
    if (t.length > 30 && !seen.has(t)) { seen.add(t); paras.push({ text: t, tag: el.tagName.toLowerCase() }); }
  });
  return { title, paragraphs: paras.slice(0, 300) };
}

/* ---- Makaleyi ortak çekirdekle render et ---- */
function renderArticle(article) {
  reader.dataset.article = JSON.stringify(article);
  reader.dataset.loaded = "1";
  KR.renderArticle(article, reader, settings, customGlossary, (span) => KR.openDetail(span));
  setTimeout(() => KR.backfillSentences(reader, settings), 900);   // cümleleri otomatik çevir
  KR.refreshStats();
}

/* ---- 📚 kayıtlı sayfalar kütüphanesi ---- */
const LIBRARY_LIMIT = 50;

async function saveToLibrary(article, url) {
  const st = await chrome.storage.local.get(["savedArticles"]);
  const list = st.savedArticles || [];
  const idx = list.findIndex((a) => url && a.url === url);
  const entry = {
    id: idx >= 0 ? list[idx].id : Date.now(),
    title: article.title,
    url,
    savedAt: Date.now(),
    paragraphs: article.paragraphs
  };
  if (idx >= 0) list[idx] = entry;          // aynı sayfa: içeriği tazele
  else {
    list.unshift(entry);
    if (list.length > LIBRARY_LIMIT) list.length = LIBRARY_LIMIT;
  }
  await chrome.storage.local.set({ savedArticles: list });
}

function toggleLibrary(show) {
  const on = show === undefined ? !libraryEl.classList.contains("on") : show;
  libraryEl.classList.toggle("on", on);
  if (on) renderLibrary();
}

async function renderLibrary() {
  const st = await chrome.storage.local.get(["savedArticles"]);
  const list = st.savedArticles || [];
  libraryEl.innerHTML = "";

  const head = document.createElement("div");
  head.className = "lib-head";
  head.innerHTML = "<b>📚 Kayıtlı sayfalar</b><span>(" + list.length + "/" + LIBRARY_LIMIT + ")</span>";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕ Kapat";
  closeBtn.addEventListener("click", () => toggleLibrary(false));
  head.appendChild(closeBtn);
  libraryEl.appendChild(head);

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "lib-empty";
    empty.innerHTML = "Henüz kayıtlı sayfa yok.<br>Okuma moduna aldığın her sayfa burada otomatik listelenir.";
    libraryEl.appendChild(empty);
    return;
  }

  list.forEach((a) => {
    const words = a.paragraphs.reduce((n, p) => {
      const t = typeof p === "string" ? p : (p.text || "");
      return n + t.split(/\s+/).filter(Boolean).length;
    }, 0);
    let host = "";
    try { if (a.url) host = new URL(a.url).hostname; } catch (e) {}
    const when = new Date(a.savedAt).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

    const item = document.createElement("div");
    item.className = "lib-item";
    item.innerHTML =
      '<div class="lib-main" title="Yan panelde aç">' +
        '<div class="lib-title"></div>' +
        '<div class="lib-meta">' + when + " · " + a.paragraphs.length + " paragraf · ~" + words + " kelime" +
          (host ? ' · <span class="lib-url"></span>' : "") + "</div>" +
      "</div>" +
      '<div class="lib-btns">' +
        '<button data-a="reader" title="Tam ekran okuyucuda aç">📖</button>' +
        '<button data-a="rename" title="Başlığı düzenle">✏️</button>' +
        '<button data-a="del" class="del" title="Sil">🗑</button>' +
      "</div>";
    item.querySelector(".lib-title").textContent = a.title;
    if (host) item.querySelector(".lib-url").textContent = host;

    // başlığa tıkla → yan panelde aç
    item.querySelector(".lib-main").addEventListener("click", () => {
      renderArticle({ title: a.title, paragraphs: a.paragraphs });
      toggleLibrary(false);
    });
    // 📖 → tam ekran okuyucu
    item.querySelector('[data-a="reader"]').addEventListener("click", async () => {
      await chrome.storage.local.set({ fullscreenArticle: { title: a.title, paragraphs: a.paragraphs } });
      await chrome.tabs.create({ url: chrome.runtime.getURL("reader.html") });
    });
    // ✏️ → başlığı düzenle
    item.querySelector('[data-a="rename"]').addEventListener("click", async () => {
      const t = prompt("Yeni başlık:", a.title);
      if (t && t.trim()) {
        a.title = t.trim();
        await chrome.storage.local.set({ savedArticles: list });
        renderLibrary();
      }
    });
    // 🗑 → sil
    item.querySelector('[data-a="del"]').addEventListener("click", async () => {
      if (!confirm("“" + a.title + "” silinsin mi?")) return;
      list.splice(list.indexOf(a), 1);
      await chrome.storage.local.set({ savedArticles: list });
      renderLibrary();
    });
    libraryEl.appendChild(item);
  });
}
