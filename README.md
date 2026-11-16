# 📖 Çeviri Eklentisi — Hover Çevirmen (Local)

Herhangi bir web sayfasında (makale, blog, online kitap…) **kelimenin üzerine gel → anlamı baloncukta gör**.
Google Translate tarzı hover çeviri — sağ tık, seçim, kopyala-yapıştır yok. Tamamen **local** çalışır.

## Ne yapar?

1. **Hover ile anında anlam:** imleci bir kelimenin üzerinde ~150 ms beklet → baloncuk açılır:
   - Yerleşik İng-Tr mini sözlükten kelime anlamı (anında, çevrimdışı)
   - **Alan (domain) seçimine göre bağlamsal anlam** — örn. DevOps seçiliyse `pipeline` "boru hattı" değil *"CI/CD hattı: kodun build→test→deploy zinciri"* olarak gösterilir.
   - Phrasal verb / ikili kalıplar (`start with`, `respond to`…) kelimenin yanında 💡 ile belirir.
   - Sözlükte olmayan kelime → **Ollama** (bilgisayarında çalışan local LLM) ile çevrilir ve kalıcı sözlüğe eklenir; bir sonraki hover'da anında gelir.
2. **Balondaki butonlar:** ✓ *Biliyorum* / 📖 *Öğreniyorum* — kelime durumu tüm ekranlarla senkron.
3. **Okuma modu (yan panel):** "Sayfayı okuma moduna al" ile makaleyi temiz görünümde oku; kelimeye tıkla → detay çekmecesi, cümle çevirisi, bağlamsal açıklama.

## Kurulum

1. Chrome'da `chrome://extensions` aç.
2. Sağ üstten **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle** → bu klasörü seç.
4. Herhangi bir İngilizce sayfayı aç ve bir kelimenin üzerine gel. 🎉

## Aç / kapat ve alan seçimi

- **Eklenti ikonuna tıkla** → hover çeviri anahtarı + alan (DevOps / Yazılım / Genel) seçici.
- Kısayol: `Alt+Shift+K` (hover'ı hızlıca aç/kapat; kapalıyken ikonda ⏸ rozeti görünür).
- ⚙️ Ayarlar sayfasından da hover anahtarı, Ollama adresi/modeli ve özel terimler yönetilir.

## Ollama (opsiyonel, tamamen local)

Sözlükte olmayan kelimelerin hover'da çevrilmesi, cümle çevirisi ve bağlamsal açıklama için:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1   # veya llama3.2, qwen2.5 vb.
ollama serve
```

Eklenti Ollama'ya `chrome-extension://` kökeninden istek atar; Ollama bu kökene izin vermezse **HTTP 403** döner. Bir kez izin ver:

```bash
# macOS (Ollama uygulaması): ayarı kaydet, sonra Ollama'yı yeniden başlat
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
# Linux / terminalden çalıştırma:
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

Ollama 0.5 ve sonrası JSON şemalı çıktıyı destekler; eklenti bunu kullanır, eski sürümlerde otomatik olarak düz JSON moduna düşer.

Ollama yoksa yerleşik sözlük + alan sözlüğü (DevOps terimleri dahil) çevrimdışı çalışmaya devam eder; hover balonunda sadece "yerleşik sözlükte yok" görürsün.

## Sınırlar

- Chrome güvenlik gereği `chrome://` sayfalarına, Chrome Web Store'a ve yerleşik PDF görüntüleyiciye eklenti enjekte etmez — bu sayfalarda hover çalışmaz.
- `chrome://extensions` sayfasında "Site erişimi" her siteye açık olmalı (paketlenmemiş yüklemede varsayılan olarak açıktır).

## Dosya yapısı

```
ceviri-eklentisi/
├── manifest.json        # MV3 tanımı (content script + popup + kısayol)
├── background.js        # tek Ollama katmanı (kuyruk, zaman aşımı) + tek yazma noktası + Alt+Shift+K + rozet
├── popup.html, js/popup.js   # ikon menüsü: hover anahtarı + alan seçici
├── js/hover.js, css/hover.css # sayfa üstü hover baloncuğu (ana özellik)
├── sidepanel.html/js    # okuma modu + detay çekmecesi
├── reader.html, js/reader.js  # tam ekran okuyucu
├── options.html/js      # ayarlar + özel terimler
└── js/
    ├── dictionary.js    # yerleşik İng-Tr sözlük + yaygın anlamlar
    ├── glossary.js      # DevOps/Yazılım bağlamsal terimler + kalıplar
    ├── ollama.js        # yan panel/okuyucu için background'a mesaj atan ince istemci
    └── store.js         # ortak yazma yardımcıları (KRStore) + yerel gün anahtarı
```

## Yol haritası önerileri

- Sözlüğü büyüt (options'tan JSON import/export)
- PDF desteği (kendi viewer sayfası ile)
- Kelime kartları / SRS (tekrar sistemi)
- Diğer alanlar: Tıp, Finans, Hukuk sözlükleri
