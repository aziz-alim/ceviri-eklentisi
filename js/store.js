/* KRStore — ortak depolama yardımcıları (content script + eklenti sayfaları).
   Paylaşılan sözlük/durum verisine YAZMA işlemleri background'daki tek kuyruktan geçer:
   sekmeler aynı anda çeviri yapsa bile kayıtlar birbirini ezmez.
   Okuma için chrome.storage.local.get + onChanged kullanılmaya devam eder. */
var KRStore = KRStore || {
  /* ops: [{op:"dictSet", store, key, value}, {op:"dictDel", store, key},
           {op:"state", w, state:"known"|"learning"|null}, {op:"ctxAdd", w, entry:{s,h,t}}] */
  mutate(ops) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "krh-mutate", ops }, (resp) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp);
        });
      } catch (e) { resolve(null); }   // eklenti yeniden yüklendiyse sessiz geç
    });
  },
  setWord(w, value) { return this.mutate([{ op: "dictSet", store: "userDict", key: w, value }]); },
  deleteWord(w) {
    return this.mutate(["userDict", "meaningsDict", "explainDict"].map((store) => ({ op: "dictDel", store, key: w })));
  },
  setState(w, state) { return this.mutate([{ op: "state", w, state }]); }
};

/* yerel saate göre gün anahtarı (YYYY-MM-DD). toISOString UTC verir; Türkiye'de gün 03:00'te dönerdi. */
var krDayKey = krDayKey || function (d) {
  d = d || new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
