/* KR.ollama — yan panel ve okuyucu için ince istemci.
   Bütün LLM çağrıları background'daki TEK Ollama katmanından geçer (kuyruk, zaman aşımı,
   şemalı JSON, saçma çıktı kontrolü). Sonuçları kalıcı depolara da background yazar;
   burada yalnızca bellekteki kopya güncellenir.
   `settings` parametresi geriye uyumluluk için duruyor; adres/model background'da okunur. */
KR.ollama = {

  _send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!resp) { reject(new Error("yanıt yok")); return; }
          if (resp.down) { reject(new Error("Failed to fetch (Ollama kapalı ya da erişilemiyor)")); return; }
          if (resp.cancelled) { reject(new Error("iptal edildi")); return; }
          if (resp.error) { reject(new Error(resp.error)); return; }
          resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  },

  /* sunucu erişilebilir mi? */
  async ping(settings, timeoutMs = 3000) {
    try { return !!(await this._send({ type: "krh-ollama", op: "ping", timeoutMs })).ok; }
    catch (e) { return false; }
  },

  async translateSentence(settings, sentence) {
    return (await this._send({ type: "krh-sentence", sentence })).t;
  },

  async explainWord(settings, word, sentence, domainLabel) {
    return (await this._send({ type: "krh-ollama", op: "explain", word, sentence, domainLabel })).t;
  },

  /* backfill: cümle listesini tek istekte çevir; sırası birebir aynı ["çeviri1","çeviri2",...] döner */
  async translateSentenceBatch(settings, sentences) {
    return (await this._send({ type: "krh-sentence-batch", sentences, batch: true })).arr || [];
  },

  /* tek kelimeyi domain bağlamında çevir (hatalı çeviriyi elle düzeltmek için) */
  async translateWord(settings, word, domainLabel) {
    return (await this._send({ type: "krh-ollama", op: "wordShort", word, domainLabel })).t;
  },

  /* kelimenin en yaygın 3 anlamı (kelime detayındaki "diğer anlamlar" için) */
  async getMeanings(settings, word) {
    try { return (await this._send({ type: "krh-ollama", op: "meanings", word })).list || []; }
    catch (e) { return []; }
  },

  /* backfill: kelime listesini tek istekte çevir, [{w,t}] döner */
  async translateBatch(settings, words, domainLabel) {
    return (await this._send({ type: "krh-ollama", op: "wordBatch", words, domainLabel })).items || [];
  }
};
