/* Çeviri Eklentisi — service worker
   Görevleri:
   1) Content script'in Ollama isteklerine proxy olmak (sayfa CSP'sine takılmaz)
   2) Alt+Shift+K ile hover çeviriyi aç/kapat + ikon rozeti
   (İkon tıklaması artık popup.html açar; yan panel oradan açılır.) */

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  chrome.action.setBadgeBackgroundColor({ color: "#c792ea" });
  syncBadge();
  cleanupTranslations(false);   // şema v2'ye tek seferlik sessiz geçiş
  // siteRules artık BEYAZ LİSTE (true = açık): eski kara liste kayıtlarını (false) temizle
  const st = await chrome.storage.local.get(["siteRules"]);
  if (st.siteRules) {
    const sr = {};
    for (const [k, v] of Object.entries(st.siteRules)) if (v === true) sr[k] = true;
    await chrome.storage.local.set({ siteRules: sr });
  }
});

chrome.runtime.onStartup.addListener(syncBadge);

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
  const day = new Date().toISOString().slice(0, 10);
  const n = st.dailyStats?.[day]?.translated || 0;
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

/* ayarlar sayfasından manuel temizlik: { type:"krh-cleanup" } */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "krh-cleanup") return;
  cleanupTranslations(true).then(sendResponse);
  return true;
});

/* ---- Ollama proxy ----
   krh-translate: { word, sentence, domainLabel } -> { t, other, note } | { down:true } | null
   krh-sentence:  { sentence }                   -> { t } | { down:true } | null */
let ollamaDownUntil = 0;

async function ollamaGenerate(prompt, system) {
  if (Date.now() < ollamaDownUntil) return { down: true };
  try {
    const st = await chrome.storage.local.get(["settings"]);
    const settings = st.settings || {};
    const url = settings.ollamaUrl || "http://localhost:11434";
    const model = settings.model || "llama3.1";
    const body = { model, prompt, stream: false, options: { temperature: 0.2 } };
    if (system) body.system = system;
    const res = await fetch(url + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("Ollama HTTP " + res.status);
    return { raw: ((await res.json()).response || "").trim() };
  } catch (e) {
    ollamaDownUntil = Date.now() + 60000;   // 1 dk boyunca hızlı "kapalı" dön
    return { down: true };
  }
}

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

/* tek cümle çevirisi — doğrulamalı, gerekiyorsa kendi kendine tekrar dener */
async function translateSentence(sentence, retries) {
  const prompt =
    `Aşağıdaki İngilizce cümleyi Türkçeye çevir.\n` +
    `Kurallar: TEK bir çeviri ver (teknik/doğal gibi ayrımlar yapma, alternatif sunma); ` +
    `akıcı ve doğal olsun; teknik terimleri gerekiyorsa aynen bırak; ` +
    `açıklama, not veya başlık ekleme; yalnızca çeviriyi yaz.\n\nCümle: "${sentence}"`;
  for (let i = 0; i < (retries || 3); i++) {
    const r = await ollamaGenerate(prompt, TR_SYS);
    if (r.down) return { down: true };
    // model yine de iki satır/alternatif dönerse ilk anlamlı satırı al
    const t = r.raw.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    const clean = t.replace(/^["']|["']$/g, "").trim();
    if (clean && !looksLikeMeta(clean, sentence)) return { t: clean };
  }
  return null;   // ısrarla saçmalıyorsa null — arayüz hata gösterir, 🔄 ile tekrar denenir
}

/* ---- günlük istatistik + rozet sayacı ----
   dailyStats: { "2026-10-19": { translated: 12 } } — 90 gün saklanır */
async function bumpDaily() {
  const day = new Date().toISOString().slice(0, 10);
  const st = await chrome.storage.local.get(["dailyStats"]);
  const ds = st.dailyStats || {};
  ds[day] = ds[day] || { translated: 0 };
  ds[day].translated++;
  const days = Object.keys(ds).sort();
  while (days.length > 90) delete ds[days.shift()];      // eski günleri budala
  await chrome.storage.local.set({ dailyStats: ds });
  const s2 = await chrome.storage.local.get(["settings"]);
  const hoverOn = !s2.settings || s2.settings.hoverEnabled !== false;
  chrome.action.setBadgeText({ text: hoverOn ? String(ds[day].translated) : "⏸" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== "krh-translate" && msg.type !== "krh-sentence" && msg.type !== "krh-sentence-batch")) return;
  (async () => {
    if (msg.type === "krh-sentence") {
      return await translateSentence(msg.sentence, 3);
    }
    if (msg.type === "krh-sentence-batch") {
      const sents = Array.isArray(msg.sentences) ? msg.sentences.slice(0, 30) : [];
      if (!sents.length) return null;
      const prompt =
        "Aşağıdaki İngilizce cümleleri Türkçeye çevir. Kurallar: her cümle için TEK, akıcı ve doğal bir çeviri; " +
        "açıklama ekleme; teknik terimleri gerekiyorsa aynen bırak. Girdi cümleleriyle BİREBİR AYNI SIRADA ve " +
        "aynı sayıda öğe içeren bir JSON dizisi döndür: [\"çeviri1\", \"çeviri2\", ...]\n\n" +
        sents.map((s, i) => (i + 1) + ". \"" + s + "\"").join("\n");
      let arr = null;
      for (let i = 0; i < 2 && !arr; i++) {
        const r = await ollamaGenerate(prompt, TR_SYS);
        if (r.down) return { down: true };
        const m = r.raw.match(/\[[\s\S]*\]/);
        if (!m) continue;
        try {
          const parsed = JSON.parse(m[0]);
          // sıra/sayı birebir tutmalı, aksi halde kaymış demektir — tekrar dene
          if (Array.isArray(parsed) && parsed.length === sents.length) {
            arr = parsed.map((x) => String(x).trim());
          }
        } catch (e) { /* tekrar dene */ }
      }
      if (!arr) return null;   // toplu çeviri tutmadı — arayüz bütün metni tek parça çevirir
      // saçma görünen öğeleri tek tek, doğrulamalı yolla tazele
      for (let i = 0; i < arr.length; i++) {
        if (looksLikeMeta(arr[i], sents[i])) {
          const one = await translateSentence(sents[i], 2);
          arr[i] = one && one.t ? one.t : arr[i];
        }
      }
      return { arr };
    }
    const domain = msg.domainLabel || "genel";
    const prompt =
      `İngilizce kelimeyi ${domain} bağlamında analiz et.\n` +
      `Kelime: "${msg.word}"\n` +
      (msg.sentence ? `Cümle: "${msg.sentence}"\n` : "") +
      `YALNIZCA şu JSON şemasında, tek yapıda cevap ver (JSON dışında hiçbir şey yazma):\n` +
      `{"anlam":"kelimenin bu bağlamdaki en uygun Türkçe karşılığı (en fazla 3 kelime)",` +
      `"diger":["varsa diğer yaygın anlam 1","diğer yaygın anlam 2"],` +
      `"aciklama":"kelimenin bu cümledeki kullanımını açıklayan 1 cümlelik Türkçe açıklama"}\n` +
      `Kurallar: teknik terimi gerekiyorsa aynen bırak; "diger" listesi boş olabilir ama anahtarlar hep bulunur.`;
    const r = await ollamaGenerate(prompt, TR_SYS);
    if (r.down) return { down: true };

    // şemalı JSON'u çöz; bozuk gelirse düz metni tek anlam olarak kullan
    const m = r.raw.match(/\{[\s\S]*\}/);
    let out = null;
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        const t = String(o.anlam || "").trim().replace(/^["']|["']$/g, "");
        if (t) {
          out = {
            t,
            other: (Array.isArray(o.diger) ? o.diger : [])
              .map((x) => String(x).trim()).filter(Boolean).slice(0, 3),
            note: String(o.aciklama || "").trim()
          };
        }
      } catch (e) { /* parse hatası: alta düş */ }
    }
    if (!out) {
      const t = r.raw.replace(/^["']|["']$/g, "").trim();
      out = t ? { t } : null;
    }
    if (out) bumpDaily();               // günlük sayaç + rozet
    return out;
  })().then(sendResponse);
  return true;   // async sendResponse
});
