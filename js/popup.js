/* Çeviri Eklentisi — popup: genel + site bazlı aç/kapa, alan seçimi, kısayollar */
const $ = (s) => document.querySelector(s);
const DEFAULTS = { domain: "devops", ollamaUrl: "http://localhost:11434", model: "llama3.1", hoverEnabled: true };

let settings = { ...DEFAULTS };
let siteRules = {};        // hostname -> true (açık); yoksa kapalı (beyaz liste)
let siteDomains = {};      // hostname -> "devops" | "software" | "general"
let curHost = "";          // aktif sekmenin alan adı (varsa)

init();
async function init() {
  const st = await chrome.storage.local.get(["settings", "siteRules", "siteDomains"]);
  settings = { ...DEFAULTS, ...(st.settings || {}) };
  siteRules = st.siteRules || {};
  siteDomains = st.siteDomains || {};
  $("#swHover").checked = settings.hoverEnabled !== false;
  $("#swHl").checked = settings.highlightEnabled !== false;

  // aktif sekmenin sitesini bul — chrome:// gibi sayfalarda site satırı gizlenir
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/.test(tab.url)) {
      curHost = new URL(tab.url).hostname;
      $("#siteHost").textContent = curHost;
      $("#swSite").checked = siteRules[curHost] === true;   // beyaz liste: varsayılan kapalı
      $("#rowSite").style.display = "";
    }
  } catch (e) {}

  // alan: bu site için seçim varsa o, yoksa genel varsayılan
  $("#selDomain").value = (curHost && siteDomains[curHost]) || settings.domain || "devops";
  $("#domHint").textContent = curHost ? "bu site için" : "varsayılan";

  // otomatik alan önerisi: içerik DevOps/Yazılım ağırlıklıysa tek tıkla uygula
  const DOM_LABEL = { devops: "DevOps / SRE", software: "Yazılım", general: "Genel" };
  try {
    const sug = await chrome.storage.local.get(["domainSuggestion"]);
    const s = sug.domainSuggestion;
    if (s && curHost && s.host === curHost && s.domain !== $("#selDomain").value) {
      $("#sugText").textContent = "Bu sayfa " + (DOM_LABEL[s.domain] || s.domain) + " ağırlıklı görünüyor";
      $("#sugRow").style.display = "";
      $("#btnSug").addEventListener("click", async () => {
        siteDomains[curHost] = s.domain;
        await chrome.storage.local.set({ siteDomains, domainSuggestion: null });
        $("#selDomain").value = s.domain;
        $("#sugRow").style.display = "none";
      });
    }
  } catch (e) {}

  // bugünkü çeviri sayısı
  try {
    const ds = await chrome.storage.local.get(["dailyStats"]);
    const n = ds.dailyStats?.[new Date().toISOString().slice(0, 10)]?.translated || 0;
    $("#todayCount").textContent = n ? " · Bugün: " + n + " çeviri" : "";
  } catch (e) {}

  $("#swHover").addEventListener("change", () => {
    settings.hoverEnabled = $("#swHover").checked;
    chrome.storage.local.set({ settings });
  });
  $("#swHl").addEventListener("change", () => {
    settings.highlightEnabled = $("#swHl").checked;
    chrome.storage.local.set({ settings });
  });
  $("#swSite").addEventListener("change", () => {
    if (!curHost) return;
    if ($("#swSite").checked) siteRules[curHost] = true;   // açık = beyaz listede
    else delete siteRules[curHost];                        // kapalı = listeden çıkar
    chrome.storage.local.set({ siteRules });
  });
  $("#selDomain").addEventListener("change", () => {
    if (curHost) {
      // site bazlı alan: bu sitede hep bu bağlamla çevir
      if ($("#selDomain").value === settings.domain) delete siteDomains[curHost];
      else siteDomains[curHost] = $("#selDomain").value;
      chrome.storage.local.set({ siteDomains });
    } else {
      settings.domain = $("#selDomain").value;             // site yoksa genel varsayılan
      chrome.storage.local.set({ settings });
    }
  });
  $("#btnOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#btnPanel").addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (e) {}
  });
}
