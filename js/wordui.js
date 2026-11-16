/* KR — ortak kelime UI: hover balonu (işaretleme butonları), 3 durum, render, detay çekmecesi */
/* Not: $ adı sidepanel.js/reader.js ile çakışmasın diye _kr$ kullanılır (klasik script'ler global kapsamı paylaşır) */
const _kr$ = (s) => document.querySelector(s);

const KR = {
  known: new Set(),       // biliyorum
  learning: new Set(),    // öğreniyorum
  userDict: {},           // Ollama ile çevrilip kaydedilen kullanıcı sözlüğü
  sentenceDict: {},       // Ollama ile çevrilip kaydedilen cümle çevirileri (cümle -> çeviri)
  meaningsDict: {},       // Ollama ile çekilen "yaygın anlamlar" listeleri (kelime -> [anlam,...])
  _tip: null, _hideTimer: null, _ctx: null,
  _detail: null, _ctxWord: "", _ctxSentence: "",

  async loadKnown() {
    const st = await chrome.storage.local.get(["knownWords", "learningWords", "userDict", "sentenceDict", "meaningsDict"]);
    if (st.knownWords) this.known = new Set(st.knownWords);
    if (st.learningWords) this.learning = new Set(st.learningWords);
    if (st.userDict) this.userDict = st.userDict;
    if (st.sentenceDict) this.sentenceDict = st.sentenceDict;
    if (st.meaningsDict) this.meaningsDict = st.meaningsDict;
    // başka ekranlar (hover, diğer sekmeler) yazınca bellekteki kopyayı tazele
    if (!this._syncing) {
      this._syncing = true;
      chrome.storage.onChanged.addListener((chg, area) => {
        if (area !== "local") return;
        if (chg.knownWords) this.known = new Set(chg.knownWords.newValue || []);
        if (chg.learningWords) this.learning = new Set(chg.learningWords.newValue || []);
        if (chg.userDict) this.userDict = chg.userDict.newValue || {};
        if (chg.sentenceDict) this.sentenceDict = chg.sentenceDict.newValue || {};
        if (chg.meaningsDict) this.meaningsDict = chg.meaningsDict.newValue || {};
        if (chg.knownWords || chg.learningWords || chg.userDict || chg.sentenceDict || chg.meaningsDict)
          document.dispatchEvent(new CustomEvent("kr-state"));
      });
    }
  },

  /* Ollama sonuçlarını kalıcı depoya background yazar (tek yazma noktası);
     bu fonksiyonlar yalnızca ekranı tazelemek için olay yayar. */
  async saveUserDict() { document.dispatchEvent(new CustomEvent("kr-state")); },
  async saveSentenceDict() { document.dispatchEvent(new CustomEvent("kr-state")); },
  async saveMeaningsDict() { document.dispatchEvent(new CustomEvent("kr-state")); },

  /* cümle çevirisi ekle; sözlük şişmesin diye en eski kayıt atılır (2000 üst sınır) */
  rememberSentence(sentence, translation) {
    if (!sentence || !translation) return;
    if (this.sentenceDict[sentence] !== undefined) return;
    const keys = Object.keys(this.sentenceDict);
    if (keys.length >= 2000) delete this.sentenceDict[keys[0]];
    this.sentenceDict[sentence] = translation;
  },

  hasMeaning(word, settings, customGlossary) {
    const { gloss, base } = this.analyze(word, settings, customGlossary);
    return !!(gloss || base);
  },

  state(w) {
    w = w.toLowerCase();
    return this.known.has(w) ? "known" : this.learning.has(w) ? "learning" : null;
  },

  async setState(w, st) {
    w = w.toLowerCase();
    this.known.delete(w); this.learning.delete(w);
    if (st === "known") this.known.add(w);
    if (st === "learning") this.learning.add(w);
    await KRStore.setState(w, st || null);
    document.dispatchEvent(new CustomEvent("kr-state"));   // istatistik çekmecesini canlı yenile
  },

  /* bilinen/bilinmiyor arasında geçiş yapar; yeni durum "bilinen" mi döner */
  async toggleKnown(w) {
    w = w.toLowerCase();
    const nowKnown = !this.known.has(w);
    await this.setState(w, nowKnown ? "known" : null);
    return nowKnown;
  },

  analyze(word, settings, customGlossary) {
    const w = word.toLowerCase();
    const gloss = GLOSSARY[settings.domain]?.[w] || GLOSSARY.software?.[w] || customGlossary?.[w] || null;
    const base = this.userDict[w] || DICTIONARY[w] || DICTIONARY[w.replace(/'s$/, "")] || null;
    return { gloss, base };
  },

  /* ikili kalıp (phrasal verb) sözlüğü: "start with", "respond to"… */
  lookupPhrase(pair, settings) {
    return PHRASES[settings.domain]?.[pair] || PHRASES.software?.[pair] || PHRASES.general?.[pair] || null;
  },

  decorateSpan(span, word, settings, customGlossary) {
    const w = word.toLowerCase();
    const st = this.state(w);
    span.classList.toggle("unknown", !st);
    span.classList.toggle("learning", st === "learning");
    const { gloss, base } = this.analyze(word, settings, customGlossary);
    let meaning = null;
    if (gloss) {
      meaning = "✅ " + (gloss[settings.domain] || gloss.devops || gloss.software ||
        Object.values(gloss).find(v => typeof v === "string"));
    } else if (base) {
      meaning = base;
    }
    if (span.dataset.phraseTr) {
      // kelime tek başına bilinse de kalıp anlamını ekle
      meaning = (meaning ? meaning + "  ·  " : "") + "💡 " + span.dataset.phrase + ": " + span.dataset.phraseTr;
    }
    if (meaning) span.dataset.meaning = meaning; else delete span.dataset.meaning;
  },

  refreshKnown(container) {
    container.querySelectorAll(".w").forEach(s => {
      if (!s.dataset.word) return;
      const st = this.state(s.dataset.word);
      s.classList.toggle("unknown", !st);
      s.classList.toggle("learning", st === "learning");
    });
  },

  /* ---- makaleyi kelime kelime render et (yan panel + tam ekran okuyucu ortak) ----
     TTS için paragraf metadata'sı döner: [{spans, offsets, sentIds}] */
  renderArticle(article, container, settings, customGlossary, onClickSpan) {
    const paragraphs = [];
    container.innerHTML = "";
    const h1 = document.createElement("h1");
    h1.textContent = article.title;
    container.appendChild(h1);

    let sid = 0;
    article.paragraphs.forEach((item) => {
      // görsel öğesi: metindeki sırasına denk aralıkta, kelimelemeye girmeden göster
      if (item && typeof item === "object" && item.img) {
        const p = document.createElement("p");
        p.className = "imgp";
        const im = document.createElement("img");
        im.src = item.img;
        im.alt = item.alt || "";
        im.loading = "lazy";
        im.title = item.alt || "Tam boyut için tıkla";
        im.addEventListener("click", () => window.open(item.img, "_blank"));
        p.appendChild(im);
        container.appendChild(p);
        paragraphs.push({ spans: [], offsets: [], sentIds: [] });   // TTS'te boş paragraf: atlanır
        return;
      }
      const para = typeof item === "string" ? item : item.text;
      const tag = typeof item === "string" ? "p" : item.tag;
      const p = document.createElement("p");
      if (/^h[1-4]$/.test(tag)) p.classList.add("h");
      if (tag === "li") p.classList.add("li");
      const paraObj = { spans: [], offsets: [], sentIds: [] };
      let offset = 0;

      if (tag === "li") { p.appendChild(document.createTextNode("• ")); offset += 2; }
      para.split(/(?<=[.!?…])\s+/).forEach((sentence) => {
        const tokens = sentence.split(/\s+/);
        let pendingPhrase = null;   // önceki kelimeyle eşleşen ikili kalıp (sonraki kelimeye işlenecek)
        for (let i = 0; i < tokens.length; i++) {
          // iç tireli kelimeler de tek token: time-to-market, zero-downtime…
          const raw = tokens[i];
          const m = raw.match(/^([\(\[\"'“‘-]*)([A-Za-zçÇğĞıİöÖşŞüÜ]+(?:[-'][A-Za-zçÇğĞıİöÖşŞüÜ]+)*)([\)\]\"'”’.,;:!?…-]*)$/);
          if (!m) {
            p.appendChild(document.createTextNode(raw + " "));
            offset += raw.length + 1;
            pendingPhrase = null;
            continue;
          }
          const span = document.createElement("span");
          span.className = "w";
          span.textContent = raw;
          span.dataset.word = m[2];
          span.dataset.sentence = sentence.trim();
          span.dataset.sid = sid;
          span.dataset.pidx = paragraphs.length;      // paragraf indeksi
          span.dataset.widx = paraObj.spans.length;   // kelime indeksi
          // ikili kalıp (phrasal verb) tespiti: "start with", "respond to"…
          let phrase = null;
          if (pendingPhrase) {
            phrase = pendingPhrase;
            pendingPhrase = null;
          } else {
            const m2 = i + 1 < tokens.length ? tokens[i + 1].match(/^[\(\[\"'“‘-]*([A-Za-zçÇğĞıİöÖşŞüÜ]+(?:[-'][A-Za-zçÇğĞıİöÖşŞüÜ]+)*)/) : null;
            if (m2) {
              const pair = (m[2] + " " + m2[1]).toLowerCase();
              const tr = this.lookupPhrase(pair, settings);
              if (tr) {
                phrase = { pair, tr };
                pendingPhrase = phrase;   // ikinci kelimeye de işlenecek
              }
            }
          }
          if (phrase) {
            span.classList.add("ph");
            span.dataset.phrase = phrase.pair;
            span.dataset.phraseTr = phrase.tr;
          }
          if (this.analyze(m[2], settings, customGlossary).gloss) span.classList.add("term");
          this.decorateSpan(span, m[2], settings, customGlossary);   // bilinme rengi + anlam ön-hesap
          if (onClickSpan) span.addEventListener("click", () => onClickSpan(span));
          p.appendChild(span);
          p.appendChild(document.createTextNode(" "));
          paraObj.spans.push(span);
          paraObj.offsets.push(offset);
          paraObj.sentIds.push(sid);
          offset += raw.length + 1;
        }
        sid++;
      });
      container.appendChild(p);
      paragraphs.push(paraObj);
    });
    this.initTooltip(container, () => settings, () => customGlossary);   // hover balonu (butonlarla)
    return paragraphs;
  },

  /* ---- kelime detay çekmecesi (her iki ekranda da aynı #detail işaretlemesi) ---- */
  initDetail({ getSettings, getCustom, onWordClick } = {}) {
    this._detail = { getSettings, getCustom, onWordClick };
    _kr$("#btnCloseDetail").addEventListener("click", () => this.closeDetail());
    _kr$("#btnTranslate").addEventListener("click", () => this._doTranslate());
    _kr$("#btnExplain").addEventListener("click", () => this._doExplain());
    _kr$("#btnKnown").addEventListener("click", () => this._doToggleKnown());
    const rt = _kr$("#btnRetranslate");
    if (rt) rt.addEventListener("click", () => this._doRetranslate());
    const dm = _kr$("#btnDeleteMeaning");
    if (dm) dm.addEventListener("click", () => this._doDeleteMeaning());
  },

  openDetail(span) {
    const d = this._detail || {};
    const settings = d.getSettings ? d.getSettings() : { domain: "devops" };
    document.querySelectorAll(".w.sel").forEach((s) => s.classList.remove("sel"));
    span.classList.add("sel");
    this._ctxWord = span.dataset.word;
    this._ctxSentence = span.dataset.sentence;
    this._markSentence(span);   // kelimenin cümlesini yarı saydam işaretle (TTS sent-on görünümü)

    _kr$("#dWord").textContent = this._ctxWord;
    _kr$("#dResult").textContent = "";
    _kr$("#dSentence").textContent = "“" + this._ctxSentence + "”";

    const gloss = this.analyze(this._ctxWord, settings, d.getCustom ? d.getCustom() : null).gloss;
    const w = this._ctxWord.toLowerCase();
    const base = this.userDict[w] || DICTIONARY[w] || DICTIONARY[w.replace(/'s$/, "")] || null;
    const glossEl = _kr$("#dGloss"), badge = _kr$("#dBadge");

    // metinler DOM düğümüyle kurulur: sözlük/LLM içeriği HTML olarak yorumlanmaz
    const lines = [];
    if (gloss) {
      // Domain terimi: genel anlamı gösterip doğrusunu söyle
      const domainGloss = gloss[settings.domain] || gloss.devops || gloss.software || Object.values(gloss)[0];
      lines.push(["⚠️ Genel sözlük anlamı (yanlış):", " " + (gloss.general || "—")]);
      lines.push(["✅ " + DOMAIN_LABELS[settings.domain] + " bağlamında doğru anlam:", " " + domainGloss]);
    }
    if (span.dataset.phraseTr) {
      lines.push(["🔤 Kalıp: “" + span.dataset.phrase + "”", " → " + span.dataset.phraseTr]);
    }
    if (lines.length) {
      glossEl.replaceChildren();
      lines.forEach(([bold, rest], i) => {
        if (i) glossEl.appendChild(document.createElement("br"));
        const b = document.createElement("b");
        b.textContent = bold;
        glossEl.append(b, rest);
      });
      glossEl.style.display = "block";
      badge.textContent = gloss ? DOMAIN_LABELS[settings.domain] + " terimi" : "kalıp (phrase)";
      badge.classList.remove("none");
    } else {
      glossEl.style.display = "none";
      badge.textContent = "genel sözlük";
      badge.classList.add("none");
    }
    _kr$("#dBase").textContent = base ? ("→ " + base) : "(yerleşik sözlükte yok — LLM ile açıklatabilirsin)";
    // 🗑 yalnızca kullanıcı sözlüğünden (Ollama) gelen çevri silinebilir
    const dm = _kr$("#btnDeleteMeaning");
    if (dm) dm.style.display = this.userDict[w] !== undefined ? "" : "none";
    _kr$("#btnKnown").textContent = this.known.has(w)
      ? "🔄 Bilinmiyor olarak işaretle" : "✓ Bu kelimeyi biliyorum";
    _kr$("#dHint").textContent = "";
    this._showSentenceTr();
    this._ensureSentenceTr(settings);   // çevirisi yoksa arka planda çek
    this._renderMeanings();             // bu cümledeki anlam + diğer yaygın anlamlar
    _kr$("#detail").classList.add("open");
    if (d.onWordClick) d.onWordClick(span);
  },

  /* detay çekmecesindeki #dSentenceTr alanını cümle çevirisiyle doldur (varsa) */
  _showSentenceTr() {
    const el = _kr$("#dSentenceTr");
    if (!el) return;
    const tr = this.sentenceDict[this._ctxSentence];
    el.textContent = tr || "";
  },

  /* çokanlamlı kelimelerde bağlam anlamını listeden ayır: kalan 2 yaygın anlamı döner */
  _otherMeanings(w, base) {
    const arr = MEANINGS[w] || this.meaningsDict[w];
    if (!arr) return [];
    if (!base) return arr.slice(0, 3);
    const bn = base.toLowerCase();
    const idx = arr.findIndex(m => m.toLowerCase() === bn);
    const rest = idx >= 0 ? arr.filter((_, i) => i !== idx) : arr.slice(1);
    return rest.slice(0, 2);
  },

  /* #dMeanings kutusunu doldur: üstte bu cümledeki anlam, altta diğer yaygın anlamlar.
     Terimlerde bağlam anlamı zaten #dGloss'ta olduğu için burada yalnızca diğerleri listelenir.
     Hiç kaynak yoksa Ollama'dan yaygın anlamları çekip önbelleğe alır. */
  _renderMeanings() {
    const el = _kr$("#dMeanings");
    if (!el) return;
    const d = this._detail || {};
    const settings = d.getSettings ? d.getSettings() : { domain: "devops" };
    const w = this._ctxWord.toLowerCase();
    const { gloss, base } = this.analyze(this._ctxWord, settings, d.getCustom ? d.getCustom() : null);
    const DOM_SHORT = { general: "genel", devops: "DevOps", software: "yazılım" };

    if (gloss) {
      const shown = gloss[settings.domain] || gloss.devops || gloss.software || Object.values(gloss)[0];
      const items = [];
      for (const [k, v] of Object.entries(gloss)) {
        if (typeof v === "string" && v !== "-" && v !== shown && !items.includes(v)) {
          items.push("• (" + (DOM_SHORT[k] || k) + ") " + v);
        }
      }
      this._fillLines(el, items.slice(0, 2).map((t) => [null, t]));
      return;
    }

    const arr = MEANINGS[w] || this.meaningsDict[w];
    if (!base && !arr) {
      el.replaceChildren();
      const word = this._ctxWord;
      KR.ollama.getMeanings(settings, word).then((list) => {
        if (list.length) {
          const keys = Object.keys(this.meaningsDict);
          if (keys.length >= 1500) delete this.meaningsDict[keys[0]];
          this.meaningsDict[word.toLowerCase()] = list;
          this.saveMeaningsDict();
        }
        if (this._ctxWord === word) this._renderMeanings();   // gelince kutuyu güncelle
      }).catch(() => {});
      return;
    }

    const others = this._otherMeanings(w, base);
    let lines = [];
    if (base) lines.push(["ctx", "💡 Bu cümlede: " + base]);
    others.forEach((o) => lines.push(["oth", "• " + o]));
    if (!base && arr && arr.length) {
      lines = [["ctx", "💡 " + arr[0]]];
      arr.slice(1, 3).forEach((o) => lines.push(["oth", "• " + o]));
    }
    this._fillLines(el, lines);
  },

  /* [sınıf, metin] satırlarını <br> ile ayrılmış span'ler olarak yaz (innerHTML yok) */
  _fillLines(el, lines) {
    el.replaceChildren();
    lines.forEach(([cls, txt], i) => {
      if (i) el.appendChild(document.createElement("br"));
      const sp = document.createElement("span");
      if (cls) sp.className = cls;
      sp.textContent = txt;
      el.appendChild(sp);
    });
  },

  /* tıklanan kelimenin cümlesini yarı saydam işaretle (TTS'teki sent-on görünümü) —
     ayrı sınıf, çünkü TTS clearHighlights() sent-on'u silerken seçimi korumalı */
  _markSentence(span) {
    document.querySelectorAll(".w.sel-sent").forEach((w) => w.classList.remove("sel-sent"));
    const sid = span.dataset.sid;
    if (sid === undefined) return;
    document.querySelectorAll(`.w[data-sid="${sid}"]`).forEach((w) => w.classList.add("sel-sent"));
  },
  _unmarkSentence() {
    document.querySelectorAll(".w.sel-sent").forEach((w) => w.classList.remove("sel-sent"));
  },

  /* cümlenin çevirisi önbellekte yoksa tek seferlik çekip göster + kaydet */
  _ensureSentenceTr(settings) {
    if (this.sentenceDict[this._ctxSentence]) return;
    const s = this._ctxSentence;
    KR.ollama.translateSentence(settings, s).then((t) => {
      this.rememberSentence(s, t);
      this.saveSentenceDict();
      if (this._ctxSentence === s) this._showSentenceTr();
    }).catch(() => {});
  },

  /* makale yüklendikten sonra tüm cümleleri toplu çevir (arka plan, Ollama varsa) */
  async backfillSentences(root, settings) {
    if (!(await KR.ollama.ping(settings, 2500))) return;
    const uniq = [...new Set([...root.querySelectorAll(".w[data-sentence]")].map(s => s.dataset.sentence))];
    const missing = uniq.filter(s => s && s.length < 400 && this.sentenceDict[s] === undefined);
    if (!missing.length) return;

    KR.toast("🌐 " + missing.length + " cümle otomatik çevriliyor…");
    const CHUNK = 6;
    let done = 0;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      try {
        const arr = await KR.ollama.translateSentenceBatch(settings, chunk);
        if (arr.length === chunk.length) {
          chunk.forEach((s, j) => this.rememberSentence(s, arr[j]));
          await this.saveSentenceDict();
          if (this._ctxSentence && this.sentenceDict[this._ctxSentence]) this._showSentenceTr();
        }
      } catch (e) { return; }
      done += chunk.length;
    }
    KR.toast("✓ " + Math.min(done, missing.length) + "/" + missing.length + " cümle çevrildi — tıkla ve gör");
  },

  closeDetail() {
    _kr$("#detail").classList.remove("open");
    document.querySelectorAll(".w.sel").forEach((s) => s.classList.remove("sel"));
    this._unmarkSentence();
  },

  async _doToggleKnown() {
    const w = this._ctxWord.toLowerCase();
    const nowKnown = await this.toggleKnown(w);
    _kr$("#btnKnown").textContent = nowKnown ? "🔄 Bilinmiyor olarak işaretle" : "✓ Bu kelimeyi biliyorum";
    this._redrawWord(w);
  },

  /* bir kelimenin tüm span'lerini güncel sözlük/durumla yeniden boya */
  _redrawWord(w) {
    const d = this._detail || {};
    document.querySelectorAll(".w").forEach((s) => {
      if (s.dataset.word && s.dataset.word.toLowerCase() === w) {
        this.decorateSpan(s, s.dataset.word,
          d.getSettings ? d.getSettings() : {},
          d.getCustom ? d.getCustom() : null);
      }
    });
  },

  /* hatalı Ollama çevirisini sil — kelime tekrar "bilinmiyor" durumuna döner */
  async _doDeleteMeaning() {
    const w = this._ctxWord.toLowerCase();
    delete this.userDict[w];
    delete this.meaningsDict[w];   // anlam listesi de aynı oturumda yanlış üretildiyse temizle
    // userDict + meaningsDict + hover'ın açıklaması (explainDict) tek işlemde silinir
    await KRStore.deleteWord(w);
    await this.saveUserDict();
    this._redrawWord(w);
    this._renderMeanings();
    _kr$("#dBase").textContent = "(çeviri silindi — 🔄 ile yeniden çevirebilirsin)";
    const dm = _kr$("#btnDeleteMeaning");
    if (dm) dm.style.display = "none";
    KR.toast("🗑 Çeviri silindi: " + this._ctxWord);
  },

  /* kelimeyi domain bağlamında tekrar çevir, userDict'e yaz, ekranı tazele */
  async _doRetranslate() {
    const btn = _kr$("#btnRetranslate");
    btn.disabled = true;
    _kr$("#dHint").textContent = "🔄 Kelime yeniden çevriliyor… (Ollama — local)";
    try {
      const settings = this._detail.getSettings();
      const w = this._ctxWord.toLowerCase();
      const t = await KR.ollama.translateWord(settings, this._ctxWord, DOMAIN_LABELS[settings.domain]);
      if (!t) throw new Error("boş yanıt");
      this.userDict[w] = t;
      await this.saveUserDict();
      this._redrawWord(w);
      _kr$("#dBase").textContent = "→ " + t;
      const dm = _kr$("#btnDeleteMeaning");
      if (dm) dm.style.display = "";
      _kr$("#dHint").textContent = "";
      KR.toast("🔄 Anlam güncellendi: " + t);
    } catch (e) {
      _kr$("#dHint").textContent = "⚠️ Ollama hatası: " + (e.message || e);
    } finally { btn.disabled = false; }
  },

  async _doTranslate() {
    const btn = _kr$("#btnTranslate"), out = _kr$("#dResult");
    btn.disabled = true; out.textContent = "Çevriliyor… (Ollama — local)";
    try {
      out.textContent = await KR.ollama.translateSentence(this._detail.getSettings(), this._ctxSentence);
    } catch (e) {
      out.textContent = "";
      const hint = _kr$("#dHint");
      hint.replaceChildren();
      const b = document.createElement("b");
      b.textContent = e.message || String(e);
      hint.append("⚠️ Ollama hatası: ", b);
      [
        "• Failed to fetch → Ollama kapalı, tünel yok ya da OLLAMA_ORIGINS eksik.",
        "• HTTP 403 → OLLAMA_ORIGINS eksik (chrome-extension izni ver).",
        "• model not found → ollama pull ile model indir ya da ⚙️ model adını düzelt.",
        "Test: curl http://localhost:11434 → 'Ollama is running' dönmeli."
      ].forEach((t) => hint.append(document.createElement("br"), t));
    } finally { btn.disabled = false; }
  },

  async _doExplain() {
    const btn = _kr$("#btnExplain"), out = _kr$("#dResult");
    btn.disabled = true; out.textContent = "Açıklanıyor… (Ollama — local)";
    try {
      const settings = this._detail.getSettings();
      out.textContent = await KR.ollama.explainWord(
        settings, this._ctxWord, this._ctxSentence, DOMAIN_LABELS[settings.domain]);
    } catch (e) {
      out.textContent = "";
      _kr$("#dHint").textContent = "⚠️ Ollama hatası: " + (e.message || e);
    } finally { btn.disabled = false; }
  },

  initTooltip(container, getSettings, getCustom) {
    if (container._krTip) return;   // aynı konteynere ikinci kez bağlanma
    container._krTip = true;
    if (!this._tip) {
      this._tip = document.createElement("div");
      this._tip.id = "kr-tip";
      document.body.appendChild(this._tip);
    }
    const tip = this._tip;
    // LR tarzı balon: kelime/kalıp pill'i + anlam listesi + kare işaretleme butonları
    tip.innerHTML =
      '<div class="tip-pill"></div>' +
      '<div class="tip-pill tip-pill2" style="display:none"></div>' +
      '<div class="tip-main"></div>' +
      '<div class="tip-alt"></div>' +
      '<div class="kr-tip-btns">' +
      '<button data-s="known" title="✓ Biliyorum">✓</button>' +
      '<button data-s="learning" title="📖 Öğreniyorum">📖</button>' +
      "</div>";

    function scheduleHide() {
      clearTimeout(this._hideTimer);
      this._hideTimer = setTimeout(() => { tip.classList.remove("on"); this._ctx = null; }, 250);
    }
    const hide = scheduleHide.bind(this);

    tip.querySelectorAll("button").forEach(b => b.addEventListener("click", async () => {
      if (!this._ctx) return;
      const w = this._ctx.word.toLowerCase();
      const cur = this.state(w);
      const next = (cur === b.dataset.s) ? null : b.dataset.s;   // aynı buton tekrar = kaldır
      await this.setState(w, next);
      document.querySelectorAll(".w").forEach(s => {
        if (s.dataset.word && s.dataset.word.toLowerCase() === w) {
          this.decorateSpan(s, s.dataset.word, getSettings(), getCustom());
        }
      });
      this._updateTipBtns();
      if (next) this.toast(next === "known" ? "✓ \"Biliyorum\" olarak işaretlendi" : "📖 \"Öğreniyorum\" listesine eklendi");
    }));

    tip.addEventListener("mouseenter", () => clearTimeout(this._hideTimer));
    tip.addEventListener("mouseleave", hide);

    container.addEventListener("mouseover", (e) => {
      const s = e.target.closest(".w");
      if (!s) return;
      clearTimeout(this._hideTimer);
      this._ctx = { word: s.dataset.word };
      const pill = tip.querySelector(".tip-pill");
      const pill2 = tip.querySelector(".tip-pill2");
      const main = tip.querySelector(".tip-main");
      const alt = tip.querySelector(".tip-alt");
      const w = s.dataset.word.toLowerCase();
      alt.innerHTML = "";

      if (s.dataset.phrase) {
        // kalıp üyesi: büyük pill = kalıp, küçük pill = hover kelimesi, altta kelimenin anlamları
        pill.textContent = s.dataset.phrase;
        pill2.style.display = "inline-block";
        pill2.textContent = s.dataset.word;
        main.textContent = "💡 " + (s.dataset.phraseTr || "");
        const { base } = this.analyze(s.dataset.word, getSettings(), getCustom());
        const arr = MEANINGS[w] || this.meaningsDict[w] || [];
        const list = (base ? [base] : []).concat(
          arr.filter(m => !base || m.toLowerCase() !== base.toLowerCase()));
        list.slice(0, 3).forEach((m) => {
          const d = document.createElement("div");
          d.className = "tip-alt-item";
          d.textContent = m;
          alt.appendChild(d);
        });
      } else {
        pill.textContent = s.dataset.word;
        pill2.style.display = "none";
        main.textContent = s.dataset.meaning || "(yerleşik sözlükte yok)";
        const { base } = this.analyze(s.dataset.word, getSettings(), getCustom());
        this._otherMeanings(w, base).forEach((m) => {
          const d = document.createElement("div");
          d.className = "tip-alt-item";
          d.textContent = m;
          alt.appendChild(d);
        });
      }
      this._updateTipBtns();
      tip.classList.add("on");
      const r = s.getBoundingClientRect();
      tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8,
        r.left + r.width / 2 - tip.offsetWidth / 2)) + "px";
      let top = r.top - tip.offsetHeight - 8;
      if (top < 70) top = r.bottom + 8;
      tip.style.top = top + "px";
    });
    container.addEventListener("mouseout", (e) => {
      if (e.target.closest(".w")) hide();
    });
    container.addEventListener("scroll", () => { tip.classList.remove("on"); this._ctx = null; }, true);
  },

  /* ---- ☰ hamburger menü: çeviri istatistikleri + kısayollar ---- */
  initStatsDrawer({ getReader, onLibrary, version } = {}) {
    this._stats = { getReader, onLibrary };
    if (document.getElementById("kr-drawer")) return;
    const overlay = document.createElement("div");
    overlay.id = "kr-drawer-overlay";
    const drawer = document.createElement("div");
    drawer.id = "kr-drawer";
    drawer.innerHTML =
      '<div class="dr-head">📖 Çeviri Eklentisi</div>' +
      '<button class="dr-item" data-dr="library">📚 Kayıtlı sayfalar <b class="dr-count" data-c="lib"></b></button>' +
      '<button class="dr-item" data-dr="options">⚙️ Ayarlar</button>' +
      '<div class="dr-sec">📊 Çeviri istatistikleri</div>' +
      '<div class="dr-stats">' +
        '<div class="stat"><span>Bu sayfa · bilinen kelime</span><b data-s="knownPct">—</b></div>' +
        '<div class="bar"><i data-b="knownPct"></i></div>' +
        '<div class="stat"><span>Bu sayfa · çeviri kapsaması</span><b data-s="covPct">—</b></div>' +
        '<div class="bar cov"><i data-b="covPct"></i></div>' +
        '<div class="stat"><span>✓ Biliyorum</span><b data-s="known">0</b></div>' +
        '<div class="stat"><span>📖 Öğreniyorum</span><b data-s="learning">0</b></div>' +
        '<div class="stat"><span>📝 Çevrilen kelime</span><b data-s="userDict">0</b></div>' +
        '<div class="stat"><span>🌐 Çevrilen cümle</span><b data-s="sent">0</b></div>' +
        '<div class="stat"><span>💡 Anlam listesi</span><b data-s="meanings">0</b></div>' +
        '<div class="stat"><span>📚 Kayıtlı sayfa</span><b data-s="lib">0</b></div>' +
      "</div>" +
      '<div class="dr-foot">' + (version || "") + " · tamamen local</div>";
    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
    overlay.addEventListener("click", () => this.toggleStatsDrawer(false));
    drawer.querySelector('[data-dr="options"]').addEventListener("click", () => chrome.runtime.openOptionsPage());
    const libBtn = drawer.querySelector('[data-dr="library"]');
    if (onLibrary) libBtn.addEventListener("click", () => { this.toggleStatsDrawer(false); onLibrary(); });
    else libBtn.style.display = "none";
    document.addEventListener("kr-state", () => this.refreshStats());
  },

  toggleStatsDrawer(show) {
    const d = document.getElementById("kr-drawer"), o = document.getElementById("kr-drawer-overlay");
    if (!d) return;
    const on = show === undefined ? !d.classList.contains("on") : show;
    d.classList.toggle("on", on);
    o.classList.toggle("on", on);
    if (on) this.refreshStats();
  },

  /* istatistikleri yeniden hesapla (çekmecenin açık olması gerekmez) */
  async refreshStats() {
    const d = document.getElementById("kr-drawer");
    if (!d || !d.classList.contains("on")) return;
    const st = await chrome.storage.local.get(["savedArticles"]);
    const libCount = (st.savedArticles || []).length;
    const setTxt = (k, v) => { const el = d.querySelector('[data-s="' + k + '"]'); if (el) el.textContent = v; };
    setTxt("known", KR.known.size);
    setTxt("learning", KR.learning.size);
    setTxt("userDict", Object.keys(KR.userDict).length);
    setTxt("sent", Object.keys(KR.sentenceDict).length);
    setTxt("meanings", Object.keys(KR.meaningsDict).length);
    setTxt("lib", libCount);
    const cEl = d.querySelector('[data-c="lib"]');
    if (cEl) cEl.textContent = libCount ? "(" + libCount + ")" : "";
    const setBar = (k, ratio) => {
      const pct = d.querySelector('[data-s="' + k + '"]'), bar = d.querySelector('[data-b="' + k + '"]');
      if (!pct || !bar) return;
      if (ratio === null) { pct.textContent = "—"; bar.style.width = "0"; return; }
      const pc = Math.round(ratio * 100);
      pct.textContent = "%" + pc;
      bar.style.width = pc + "%";
    };
    const root = this._stats && this._stats.getReader ? this._stats.getReader() : null;
    const spans = root ? [...root.querySelectorAll(".w[data-word]")] : [];
    if (!spans.length) { setBar("knownPct", null); setBar("covPct", null); return; }
    const seen = new Set();
    let total = 0, known = 0, cov = 0;
    for (const s of spans) {
      const w = s.dataset.word.toLowerCase();
      if (seen.has(w)) continue;
      seen.add(w); total++;
      if (KR.known.has(w)) known++;
      if (s.dataset.meaning) cov++;
    }
    setBar("knownPct", known / total);
    setBar("covPct", cov / total);
  },

  _updateTipBtns() {
    const st = this._ctx ? this.state(this._ctx.word) : null;
    this._tip.querySelectorAll("button").forEach(b => b.classList.toggle("active", st === b.dataset.s));
  },

  toast(msg) {
    let t = document.getElementById("kr-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "kr-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("on"), 2600);
  }
};
