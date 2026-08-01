const sessionKey = "shunji.session.v1";
const deckKey = "shunji.deck.v1";
const dayKey = "shunji.last-day.v1";
const maximumCards = 80;

/** @typedef {{alternatives:string[],headword:string,id:number,readings:string[],score:number,senses:Array<{glosses:string[],info:string[],parts:string[]}>}} Entry */

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage may be unavailable in private or hardened browser modes.
    }
  },
};

const sessionId = (() => {
  const existing = storage.get(sessionKey);
  if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing;
  const created = crypto.randomUUID();
  storage.set(sessionKey, created);
  return created;
})();

const apiHeaders = () => ({
  "content-type": "application/json",
  "x-shunji-qa": navigator.webdriver ? "1" : "0",
  "x-shunji-session": sessionId,
});

const jstDay = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const sendMetric = (name, entryId) => {
  const body = entryId ? { entryId, name } : { name };
  void fetch("/api/telemetry", {
    body: JSON.stringify(body),
    headers: apiHeaders(),
    keepalive: true,
    method: "POST",
  }).catch(() => undefined);
};

const noteVisit = () => {
  sendMetric("visited");
  const today = jstDay();
  const lastDay = storage.get(dayKey);
  if (lastDay && lastDay < today) sendMetric("returned");
  storage.set(dayKey, today);
};

/** @returns {Entry[]} */
const readDeck = () => {
  try {
    const parsed = JSON.parse(storage.get(deckKey) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Number.isInteger(entry.id) &&
        typeof entry.headword === "string" &&
        Array.isArray(entry.senses),
    );
  } catch {
    return [];
  }
};

/** @param {Entry[]} deck */
const writeDeck = (deck) => storage.set(deckKey, JSON.stringify(deck.slice(0, maximumCards)));

const text = (tag, content, className) => {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
};

/** @param {Entry} entry */
const shortGloss = (entry) =>
  entry.senses
    .flatMap((sense) => sense.glosses)
    .slice(0, 2)
    .join("; ");

/** @param {Entry} entry */
const createDeckItem = (entry) => {
  const item = document.createElement("article");
  item.className = "deck-item";
  item.dataset.entryId = String(entry.id);
  item.append(text("span", entry.headword.slice(0, 1)));
  const content = document.createElement("div");
  const link = document.createElement("a");
  link.href = `/entry/${entry.id}`;
  link.append(text("b", entry.headword));
  content.append(link, text("small", shortGloss(entry)));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `${entry.headword}を単語札から外す`);
  remove.addEventListener("click", () => toggleSaved(entry));
  item.append(content, remove);
  return item;
};

const updateSaveButtons = () => {
  const ids = new Set(readDeck().map((entry) => entry.id));
  for (const button of document.querySelectorAll(".save-entry")) {
    if (!(button instanceof HTMLButtonElement)) continue;
    const raw = button.dataset.entry;
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw);
      const saved = ids.has(entry.id);
      button.dataset.saved = saved ? "true" : "false";
      button.textContent = saved ? "札から外す" : "札へ残す";
    } catch {
      button.disabled = true;
    }
  }
};

const renderDeck = () => {
  const deck = readDeck();
  const host = document.querySelector("#deck");
  const empty = document.querySelector("#empty-deck");
  const clear = document.querySelector("#clear-deck");
  if (host) host.replaceChildren(...deck.map(createDeckItem));
  if (empty instanceof HTMLElement) empty.hidden = deck.length > 0;
  if (clear instanceof HTMLButtonElement) clear.hidden = deck.length === 0;
  updateSaveButtons();
};

/** @param {Entry} entry */
function toggleSaved(entry) {
  const deck = readDeck();
  const existing = deck.findIndex((item) => item.id === entry.id);
  if (existing >= 0) {
    deck.splice(existing, 1);
  } else {
    deck.unshift(entry);
    sendMetric("saved", entry.id);
  }
  if (!writeDeck(deck)) {
    const status = document.querySelector("#search-status");
    if (status) status.textContent = "このブラウザーでは単語札を保存できませんでした";
  }
  renderDeck();
}

/** @param {Entry} entry */
const createSenseList = (entry) => {
  const list = document.createElement("ol");
  list.className = "sense-list";
  for (const [index, sense] of entry.senses.entries()) {
    const item = document.createElement("li");
    item.append(text("span", String(index + 1), "sense-number"));
    const content = document.createElement("div");
    content.append(text("p", sense.glosses.join("; ")));
    const labels = [...sense.parts.slice(0, 4), ...sense.info.slice(0, 3)];
    if (labels.length) {
      const tags = document.createElement("div");
      tags.className = "sense-tags";
      tags.append(...labels.map((label) => text("span", label)));
      content.append(tags);
    }
    item.append(content);
    list.append(item);
  }
  return list;
};

/** @param {Entry} entry */
const createEntryCard = (entry) => {
  const article = document.createElement("article");
  article.className = "entry-card";
  article.dataset.entryCard = "";
  article.append(text("div", entry.headword.slice(0, 1), "entry-card-index"));
  const body = document.createElement("div");
  body.className = "entry-card-body";
  body.append(text("p", entry.readings.join("・"), "reading-line"));
  body.append(text("h2", entry.headword));
  if (entry.alternatives.length) {
    body.append(
      text("p", `表記・読み：${entry.alternatives.slice(0, 8).join("・")}`, "alternative-line"),
    );
  }
  body.append(createSenseList(entry));
  article.append(body);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "save-entry";
  save.dataset.entry = JSON.stringify(entry);
  save.addEventListener("click", () => toggleSaved(entry));
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-entry";
  copy.dataset.copy = entry.headword;
  copy.textContent = "語をコピー";
  copy.addEventListener("click", () => copyWord(copy));
  const link = document.createElement("a");
  link.href = `/entry/${entry.id}`;
  link.textContent = "一枚で開く";
  actions.append(save, copy, link);
  article.append(actions, text("div", "", "card-notch"));
  return article;
};

/** @param {HTMLButtonElement} button */
const copyWord = async (button) => {
  const value = button.dataset.copy ?? "";
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "コピーしました";
    window.setTimeout(() => {
      button.textContent = "語をコピー";
    }, 1500);
    const card = button.closest("[data-entry-card]");
    const save = card?.querySelector(".save-entry");
    if (save instanceof HTMLButtonElement && save.dataset.entry) {
      const entry = JSON.parse(save.dataset.entry);
      sendMetric("copied", entry.id);
    }
  } catch {
    button.textContent = "コピーできませんでした";
  }
};

const bindServerCards = () => {
  for (const button of document.querySelectorAll(".save-entry")) {
    if (!(button instanceof HTMLButtonElement) || button.dataset.bound === "true") continue;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      if (!button.dataset.entry) return;
      try {
        toggleSaved(JSON.parse(button.dataset.entry));
      } catch {
        button.disabled = true;
      }
    });
  }
  for (const button of document.querySelectorAll(".copy-entry")) {
    if (!(button instanceof HTMLButtonElement) || button.dataset.bound === "true") continue;
    button.dataset.bound = "true";
    button.addEventListener("click", () => copyWord(button));
  }
};

const bindSearch = () => {
  const form = document.querySelector("#search-form");
  const input = document.querySelector("#query");
  const status = document.querySelector("#search-status");
  const section = document.querySelector("#results-section");
  const host = document.querySelector("#results");
  const count = document.querySelector("#results-count");
  const title = document.querySelector("#results-title");
  if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!query) {
      input.focus();
      if (status) status.textContent = "引きたい語を入力してください";
      return;
    }
    const submit = form.querySelector("button[type='submit']");
    if (submit instanceof HTMLButtonElement) submit.disabled = true;
    if (status) status.textContent = "辞書をめくっています…";
    try {
      const response = await fetch("/api/search", {
        body: JSON.stringify({ query }),
        headers: apiHeaders(),
        method: "POST",
      });
      if (!response.ok) throw new Error("search_failed");
      const payload = await response.json();
      /** @type {Entry[]} */
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      if (host) host.replaceChildren(...entries.map(createEntryCard));
      if (section instanceof HTMLElement) section.hidden = false;
      if (count) count.textContent = `${entries.length}件表示`;
      if (title)
        title.textContent = entries.length ? `「${query}」の辞書札` : "該当する語がありません";
      if (status) {
        status.textContent = entries.length
          ? `${entries.length}件を表示しました`
          : "表記を短くするか、読み・英語でも試してください";
      }
      updateSaveButtons();
      section?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      if (status) status.textContent = "辞書を開けませんでした。少し待ってもう一度お試しください";
    } finally {
      if (submit instanceof HTMLButtonElement) submit.disabled = false;
    }
  });
};

const bindClear = () => {
  const clear = document.querySelector("#clear-deck");
  if (!(clear instanceof HTMLButtonElement)) return;
  clear.addEventListener("click", () => {
    if (!window.confirm("この端末の単語札をすべて外しますか？")) return;
    storage.remove(deckKey);
    renderDeck();
  });
};

noteVisit();
bindSearch();
bindClear();
bindServerCards();
renderDeck();

const opened = document.querySelector("[data-open-entry]");
if (opened instanceof HTMLElement) {
  const id = Number(opened.dataset.openEntry);
  if (Number.isInteger(id)) sendMetric("entry_opened", id);
}
