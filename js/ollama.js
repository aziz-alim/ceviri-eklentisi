/* KR.ollama — Ollama (local LLM) ortak istemcisi.
   Uzak sunucu + SSH tüneli için ollamaUrl ayarı: http://localhost:11434 (tünel portu) */
KR.ollama = {

  async generate(settings, prompt) {
    const res = await fetch(settings.ollamaUrl + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.model, prompt, stream: false })
    });
    if (!res.ok) throw new Error("Ollama HTTP " + res.status);
    return (await res.json()).response;
  },

  /* sunucu erişilebilir mi? */
  async ping(settings, timeoutMs = 3000) {
    try {
      const r = await fetch(settings.ollamaUrl + "/api/tags", { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok;
    } catch (e) {
      return false;
    }
  },

  async translateSentence(settings, sentence) {
    return (await this.generate(settings,
      `Aşağıdaki İngilizce cümleyi teknik ve doğal Türkçeye çevir. Sadece çeviriyi yaz, açıklama ekleme.\n\nCümle: "${sentence}"`
    )).trim();
  },

  async explainWord(settings, word, sentence, domainLabel) {
    return (await this.generate(settings,
      `Sen bir teknik çeviri asistanısın. Alan: ${domainLabel}.\n` +
      `İngilizce cümle: "${sentence}"\nKelime: "${word}"\n` +
      `Bu kelimeyi bu cümledeki kullanımına göre 1-2 cümleyle Türkçe açıkla; gerekiyorsa çevirme, teknik terimi koru. Kısa ve net ol.`
    )).trim();
  },

  /* backfill: cümle listesini tek istekte çevir; sırası birebir aynı ["çeviri1","çeviri2",...] döner */
  async translateSentenceBatch(settings, sentences) {
    const r = await this.generate(settings,
      "Aşağıdaki İngilizce cümleleri teknik ve doğal Türkçeye çevir. Kurallar: her cümle için yalnızca çeviri; " +
      "açıklama ekleme; teknik terimleri gerektiğinde aynen bırak. Girdi cümleleriyle BİREBİR AYNI SIRADA ve " +
      "aynı sayıda öğe içeren bir JSON dizisi döndür: [\"çeviri1\", \"çeviri2\", ...]\n\n" +
      sentences.map((s, i) => (i + 1) + ". \"" + s + "\"").join("\n")
    );
    const m = r.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      const arr = JSON.parse(m[0]);
      return Array.isArray(arr) ? arr.map(x => String(x).trim()) : [];
    } catch (e) { return []; }
  },

  /* tek kelimeyi domain bağlamında çevir (hatalı çeviriyi elle düzeltmek için) */
  async translateWord(settings, word, domainLabel) {
    return (await this.generate(settings,
      `"${word}" İngilizce kelimesini ${domainLabel} bağlamında Türkçeye çevir. ` +
      `Kurallar: en fazla 3 kelimelik kısa karşılık; teknik terimi gerekiyorsa aynen bırak. ` +
      `YALNIZCA karşılığı yaz, başka hiçbir şey ekleme.`
    )).trim();
  },

  /* kelimenin en yaygın 3 anlamını dizi olarak döner (kelime detayındaki "diğer anlamlar" için) */
  async getMeanings(settings, word) {
    const r = await this.generate(settings,
      `İngilizce "${word}" kelimesinin en yaygın 3 Türkçe anlamını, en sık kullanımdan daha nadir olana doğru ` +
      `sıralayarak YALNIZCA JSON dizisi olarak döndür: ["anlam1","anlam2","anlam3"]. ` +
      `Kurallar: her anlam en fazla 4 kelime; teknik bağlam öncelikli.`
    );
    const m = r.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      const arr = JSON.parse(m[0]);
      return Array.isArray(arr) ? arr.map(x => String(x).trim()).filter(Boolean).slice(0, 3) : [];
    } catch (e) { return []; }
  },

  /* backfill: kelime listesini tek istekte çevir, [{w,t}] döner */
  async translateBatch(settings, words, domainLabel) {
    const r = await this.generate(settings,
      "Aşağıdaki İngilizce kelimeleri " + domainLabel +
      " bağlamında Türkçeye çevir. Kurallar: her kelime için en fazla 3 kelimelik kısa karşılık; " +
      "teknik terimi gerekiyorsa aynen bırak. YALNIZCA JSON döndür: [{\"w\":\"kelime\",\"t\":\"karşılık\"},...]\n\n" +
      "Kelimeler: " + words.join(", ")
    );
    const m = r.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try { return JSON.parse(m[0]); } catch (e) { return []; }
  }
};
