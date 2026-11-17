const $ = (id) => document.getElementById(id);
// Not named "sage": the preload already defines window.sage, and declaring it
// again here would stop this whole script from loading.
const api = window.sage;

let state = null;
let busy = false;
let live = false; // the thread is the current conversation, so follow-ups and retries work
let card = null; // the answer being written
let lastCard = null;
let recording = false;
let view = 'answer';

// ---------- a small, safe Markdown renderer ----------

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

function markdown(source) {
  const lines = source.replace(/\r/g, '').split('\n');
  const out = [];
  let paragraph = [];
  let list = null; // 'ul' | 'ol'
  const endParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const endList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      endParagraph();
      endList();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      endParagraph();
      endList();
      out.push(`<h4>${inline(heading[1])}</h4>`);
    } else if (bullet || numbered) {
      endParagraph();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        endList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
    } else if (!line.trim()) {
      endParagraph();
      endList();
    } else {
      endList();
      paragraph.push(line);
    }
  }
  endParagraph();
  endList();
  return out.join('');
}

// ---------- reading the reply ----------
// The model is asked for <answer>…</answer><working>…</working>. While it is
// still writing, a tag can be half finished, so that part is hidden.

function splitReply(raw, done) {
  const text = raw.replace(/<\/?[a-z]*$/i, '');
  const answer = text.match(/<answer>\s*([\s\S]*?)\s*(?:<\/answer>|<working>|$)/i);
  const working = text.match(/<working>\s*([\s\S]*?)\s*(?:<\/working>|$)/i);
  if (answer || working) {
    return { answer: answer ? answer[1].trim() : '', working: working ? working[1].trim() : '' };
  }
  const plain = text.trim();
  if (!done) return { answer: plain, working: '' };
  // The model ignored the format: the first paragraph is the answer, the rest the working.
  const [first, ...rest] = plain.split(/\n\s*\n/);
  return { answer: (first || '').trim(), working: rest.join('\n\n').trim() };
}

// ---------- views and sizing ----------

const views = { answer: $('view-answer'), history: $('view-history'), settings: $('view-settings') };
let lastHeight = 0;

/** The window eases to fit what it is showing. While an answer streams in it only grows, in steps. */
function measure() {
  const inner = views[view].querySelector('.inner');
  const toast = $('toast').hidden ? 0 : $('toast').offsetHeight + 6;
  let height = $('bar').offsetHeight + inner.offsetHeight + toast + $('footer').offsetHeight + 2;
  if (busy) height = Math.max(lastHeight, Math.ceil(height / 28) * 28);
  if (Math.abs(height - lastHeight) >= 1) {
    lastHeight = height;
    api.setHeight(height);
  }
}

let measureQueued = false;
function queueMeasure() {
  if (measureQueued) return;
  measureQueued = true;
  requestAnimationFrame(() => {
    measureQueued = false;
    measure();
  });
}

const sizeWatcher = new ResizeObserver(queueMeasure);
for (const element of document.querySelectorAll('.inner, #footer, #toast')) sizeWatcher.observe(element);

function show(name) {
  if (name === view) return;
  view = name;
  for (const [key, element] of Object.entries(views)) element.hidden = key !== name;
  $('historyBtn').classList.toggle('on', name === 'history');
  $('settingsBtn').classList.toggle('on', name === 'settings');
  if (name === 'history') loadHistory();
  if (name === 'settings') openSettings();
  setBusy(busy); // the follow-up box only belongs on the answer view
}

$('historyBtn').addEventListener('click', () => show(view === 'history' ? 'answer' : 'history'));
$('settingsBtn').addEventListener('click', () => show(view === 'settings' ? 'answer' : 'settings'));
$('frameBtn').addEventListener('click', () => api.toggleFrame());
$('selectBtn').addEventListener('click', () => api.selectArea());
$('timerBtn').addEventListener('click', () => api.toggleTimer());
$('closeBtn').addEventListener('click', () => api.close());

let toastTimer = null;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4500);
}

// ---------- the answer card ----------

const thread = $('thread');
const scrollDown = () => (views.answer.scrollTop = views.answer.scrollHeight);
const clock = (time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const icon = (path) => `<svg viewBox="0 0 16 16"><path d="${path}"/></svg>`;

function thumbButton(meta) {
  const button = document.createElement('button');
  button.className = 'thumb';
  button.title = 'View capture';
  button.setAttribute('aria-label', 'View capture');
  button.style.backgroundImage = `url("${meta.thumb}")`;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    api.openImage(meta.id);
  });
  return button;
}

function disclosure(title, pref, extraClass) {
  const wrap = document.createElement('div');
  wrap.className = `disclosure ${extraClass || ''}`;
  wrap.hidden = true;
  wrap.innerHTML = `<button class="disclose">${icon('M6 3.5 10.5 8 6 12.5')}<span></span></button><div class="fold"><div class="body"></div></div>`;
  wrap.querySelector('span').textContent = title;
  const button = wrap.querySelector('.disclose');
  const set = (open) => {
    wrap.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
  };
  set(!!(state && state.prefs.answers[pref]));
  button.addEventListener('click', () => {
    const open = !wrap.classList.contains('open');
    set(open);
    setPref(`answers.${pref}`, open); // remembered for the next answer
  });
  return { wrap, body: wrap.querySelector('.body') };
}

function newCard(meta) {
  const el = document.createElement('article');
  el.className = 'card';
  const top = document.createElement('div');
  top.className = 'card-top';
  if (meta && meta.thumb) top.appendChild(thumbButton(meta));
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = meta ? clock(meta.time) : '';
  top.appendChild(time);
  if (meta) el.appendChild(top);

  const answer = document.createElement('div');
  answer.className = 'answer';
  const working = disclosure('Working out', 'showWorking');
  const thinking = disclosure('Thinking', 'showThinking', 'thinking');
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.innerHTML =
    `<button class="ghost retry">${icon('M13.25 8a5.25 5.25 0 1 1-1.55-3.7M13.25 2.75v2.5h-2.5')}<span>Wrong answer</span></button>` +
    `<button class="ghost copy">${icon('M5.5 5.5V3.75c0-.7.55-1.25 1.25-1.25h5.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25H10.5M3.75 5.5h5.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25h-5.5c-.7 0-1.25-.55-1.25-1.25v-5.5c0-.7.55-1.25 1.25-1.25Z')}<span>Copy</span></button>`;
  el.append(answer, working.wrap, thinking.wrap, actions);
  thread.appendChild(el);

  const c = { el, answer, working, thinking, actions, text: '', thoughts: '', done: false, shown: false, parts: { answer: '' } };
  actions.querySelector('.retry').addEventListener('click', () => {
    if (!busy && live && c === lastCard) api.retry();
  });
  actions.querySelector('.copy').addEventListener('click', (event) => {
    api.copy(c.parts.answer);
    const label = event.currentTarget.querySelector('span');
    label.textContent = 'Copied';
    setTimeout(() => (label.textContent = 'Copy'), 1400);
  });
  if (lastCard) lastCard.actions.querySelector('.retry').hidden = true;
  lastCard = c;
  paint(c);
  return c;
}

function paint(c) {
  c.parts = splitReply(c.text, c.done);
  const { answer, working } = c.parts;
  if (answer) {
    const reveal = !c.shown;
    c.shown = true;
    c.answer.className = `answer${answer.length > 140 ? ' long' : ''}${reveal ? ' reveal' : ''}`;
    c.answer.innerHTML = markdown(answer);
  } else if (c.done) {
    c.answer.className = 'answer quiet';
    c.answer.textContent = 'No answer came back.';
  } else if (!c.answer.querySelector('.dots')) {
    c.answer.className = 'answer';
    c.answer.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  }
  c.working.wrap.hidden = !working;
  if (working) c.working.body.innerHTML = markdown(working);
  c.thinking.wrap.hidden = !c.thoughts.trim();
  if (c.thoughts) c.thinking.body.textContent = c.thoughts.trim();
  c.actions.hidden = !(c.done && answer);
  c.actions.querySelector('.retry').hidden = !(live && c === lastCard);
}

function addBubble(text) {
  const el = document.createElement('div');
  el.className = 'bubble';
  el.textContent = text;
  thread.appendChild(el);
}

function startThread() {
  show('answer');
  thread.textContent = '';
  lastCard = null;
}

function setBusy(value) {
  busy = value;
  $('ask').classList.toggle('busy', busy);
  $('askLabel').textContent = busy ? 'Stop' : 'Answer';
  $('compose').hidden = !live || view !== 'answer';
  $('question').disabled = busy;
  $('send').disabled = busy;
  queueMeasure();
}

api.onStart((meta) => {
  startThread();
  live = false;
  card = meta ? newCard(meta) : null;
  setBusy(true);
});

api.onFollowUp((question) => {
  addBubble(question);
  card = newCard(null);
  setBusy(true);
  scrollDown();
});

// "Wrong answer": the same card fades out its answer and fills in the new one.
api.onRetry(() => {
  if (!lastCard) return;
  card = lastCard;
  Object.assign(card, { text: '', thoughts: '', done: false, shown: false });
  paint(card);
  setBusy(true);
});

api.onChunk((piece) => {
  if (!card) return;
  card.text += piece;
  paint(card);
  scrollDown();
});

api.onThinking((piece) => {
  if (!card) return;
  card.thoughts += piece;
  paint(card);
});

function finish() {
  if (card) {
    if (!card.text && !card.thoughts && card !== lastCard) card.el.remove();
    card.done = true;
    live = live || !!card.text;
    paint(card);
  }
  card = null;
  setBusy(false);
}

api.onDone(finish);

api.onError((message) => {
  if (card && !card.text) {
    card.el.remove();
    if (card === lastCard) lastCard = null;
    card = null;
  }
  finish();
  const el = document.createElement('div');
  el.className = 'card error';
  el.textContent = message;
  thread.appendChild(el);
  scrollDown();
});

api.onReset(() => {
  live = false;
  thread.textContent = '';
  lastCard = null;
  setBusy(false);
  loadStorage();
});

$('ask').addEventListener('click', () => (busy ? api.stop() : api.ask()));

$('compose').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = $('question').value.trim();
  if (busy || !live || !question) return;
  $('question').value = '';
  api.followUp(question);
});

// ---------- recents ----------

async function loadHistory(items) {
  const list = items || (await api.history());
  const box = $('historyList');
  box.textContent = '';
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No recents yet.';
    box.appendChild(p);
    return;
  }
  list.forEach((entry, index) => {
    const answers = entry.messages.filter((m) => m.role === 'assistant');
    const last = answers[answers.length - 1];
    const row = document.createElement('div');
    row.className = 'entry';
    row.style.animationDelay = `${Math.min(index, 8) * 25}ms`;
    row.appendChild(thumbButton(entry));
    const open = document.createElement('button');
    open.className = 'open';
    open.innerHTML = '<span class="title"></span><span class="when"></span>';
    const answer = last ? splitReply(last.content, true).answer : '';
    open.querySelector('.title').textContent = answer.replace(/[#*`]/g, '').replace(/\s+/g, ' ') || 'No answer';
    open.querySelector('.when').textContent = `${new Date(entry.time).toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${clock(entry.time)}`;
    open.addEventListener('click', () => openSaved(entry));
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.title = 'Delete';
    remove.setAttribute('aria-label', 'Delete');
    remove.innerHTML = icon('M5 5l6 6M11 5l-6 6');
    remove.addEventListener('click', async () => loadHistory(await api.deleteHistory(entry.id)));
    row.append(open, remove);
    box.appendChild(row);
  });
}

function openSaved(entry) {
  if (busy) return;
  startThread();
  live = false;
  const messages = entry.messages;
  let first = true;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === 'user') {
      if (!message.retry && message.content) addBubble(message.content);
      continue;
    }
    // An answer marked wrong was replaced by the next one.
    if (messages[i + 1] && messages[i + 1].retry) continue;
    const c = newCard(first ? entry : null);
    first = false;
    Object.assign(c, { text: message.content, thoughts: message.thinking || '', done: true });
    paint(c);
  }
  setBusy(false);
  views.answer.scrollTop = 0;
}

// ---------- settings ----------

const prefValue = (path) => {
  const [section, key] = path.split('.');
  return state.prefs[section][key];
};

async function setPref(path, value) {
  const [section, key] = path.split('.');
  const result = await api.setPref(section, { [key]: value });
  if (result.error) toast(result.error);
  render(result.state);
}

function paintRange(input) {
  const share = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill-to', `${share}%`);
}

for (const control of document.querySelectorAll('input[data-pref]')) {
  control.addEventListener(control.type === 'range' ? 'input' : 'change', () => {
    if (control.type === 'range') paintRange(control);
    setPref(control.dataset.pref, control.type === 'checkbox' ? control.checked : Number(control.value));
  });
}

function fillPrefs() {
  for (const control of document.querySelectorAll('input[data-pref]')) {
    const value = prefValue(control.dataset.pref);
    if (control.type === 'checkbox') control.checked = !!value;
    else if (document.activeElement !== control) control.value = value;
    if (control.type === 'range') paintRange(control);
  }
}

function moveChip() {
  const on = $('tabs').querySelector('button.on');
  if (!on || !on.offsetWidth) return;
  $('tabChip').style.width = `${on.offsetWidth}px`;
  $('tabChip').style.transform = `translateX(${on.offsetLeft}px)`;
}

for (const tab of $('tabs').querySelectorAll('button')) {
  tab.addEventListener('click', () => {
    for (const other of $('tabs').querySelectorAll('button')) other.classList.toggle('on', other === tab);
    for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    moveChip();
    if (tab.dataset.tab === 'storage') loadStorage();
  });
}

function openSettings() {
  requestAnimationFrame(moveChip);
  refreshModels();
  loadStorage();
}

$('frameShown').addEventListener('change', () => api.toggleFrame());
$('drawArea').addEventListener('click', () => api.selectArea());
$('resetPositions').addEventListener('click', () => api.resetPositions());

// Storage

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showStorage(info) {
  if (!info) return;
  $('recentsInfo').textContent = `${info.recents} · ${formatBytes(info.recentsBytes)}`;
  $('totalInfo').textContent = formatBytes(info.totalBytes);
  $('clearRecents').disabled = !info.recents;
}

async function loadStorage() {
  showStorage(await api.storage());
}

$('clearRecents').addEventListener('click', async () => {
  showStorage(await api.clearRecents());
  if (view === 'history') loadHistory();
});

// Deleting everything takes two presses.
let armTimer = null;
$('deleteAll').addEventListener('click', async () => {
  const button = $('deleteAll');
  if (!button.classList.contains('armed')) {
    button.classList.add('armed');
    button.textContent = 'Press again to delete everything';
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      button.classList.remove('armed');
      button.textContent = 'Delete all local data';
    }, 3500);
    return;
  }
  clearTimeout(armTimer);
  button.classList.remove('armed');
  button.textContent = 'Delete all local data';
  showStorage(await api.deleteAll());
});

// Shortcut

const KEY_NAMES = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
};

function acceleratorFrom(event) {
  let key = null;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  else if (/^F\d{1,2}$/.test(event.code)) key = event.code;
  else key = KEY_NAMES[event.code] || null;
  if (!key) return null;
  const mods = [];
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');
  // A plain letter would fire while typing, so require Ctrl, Alt or Win (F-keys are fine alone).
  if (!(event.ctrlKey || event.altKey || event.metaKey) && !/^F\d/.test(key)) return null;
  return [...mods, key].join('+');
}

function setRecording(on) {
  recording = on;
  $('hotkey').classList.toggle('recording', on);
  $('hotkey').textContent = on ? 'Press keys…' : state.hotkeyLabel;
}

$('hotkey').addEventListener('click', () => setRecording(!recording));

window.addEventListener(
  'keydown',
  (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'Escape') return setRecording(false);
    const accelerator = acceleratorFrom(event);
    if (!accelerator) return;
    recording = false;
    setPref('behaviour.hotkey', accelerator).then(() => setRecording(false));
  },
  true,
);

// Provider and model

const activeProvider = () => state.providers.find((p) => p.id === state.provider);

function note(message) {
  $('aiNote').textContent = message || '';
  $('aiNote').hidden = !message;
}

function showModels(models, chosen) {
  const select = $('model');
  select.textContent = '';
  const names = models.includes(chosen) || !chosen ? models : [chosen, ...models];
  if (!names.length) select.add(new Option('None found', ''));
  for (const name of names) select.add(new Option(name, name));
  select.value = chosen || '';
}

async function refreshModels() {
  const provider = activeProvider();
  if (provider.needsKey && !provider.hasKey) {
    showModels([], provider.model);
    note('');
    return;
  }
  $('refresh').classList.add('spin');
  const result = await api.listModels(provider.id);
  $('refresh').classList.remove('spin');
  if (provider.id !== state.provider) return; // the provider was switched meanwhile
  if (!result.ok) {
    showModels([], provider.model);
    note(result.error);
    return;
  }
  render(result.state);
  showModels(result.models, activeProvider().model);
  note(result.models.length ? '' : 'No models that can read pictures were found.');
}

$('provider').addEventListener('change', async (event) => {
  render(await api.setProvider(event.target.value));
  $('key').value = '';
  refreshModels();
});

$('model').addEventListener('change', async (event) => {
  if (event.target.value) render(await api.setModel(state.provider, event.target.value));
});

$('refresh').addEventListener('click', refreshModels);

async function saveKey(key) {
  const result = await api.setKey(state.provider, key);
  $('key').value = '';
  if (!result.ok) return note(result.error);
  render(result.state);
  refreshModels();
}

$('key').addEventListener('change', () => $('key').value.trim() && saveKey($('key').value.trim()));
$('removeKey').addEventListener('click', () => saveKey(''));
$('keyLink').addEventListener('click', () => api.openKeyPage(state.provider));

$('baseUrl').addEventListener('change', async () => {
  const result = await api.setBaseUrl(state.provider, $('baseUrl').value.trim());
  if (!result.ok) return note(result.error);
  render(result.state);
  refreshModels();
});

for (const input of [$('baseUrl'), $('key')]) {
  input.addEventListener('keydown', (event) => event.key === 'Enter' && input.blur());
}

// ---------- render ----------

function render(next) {
  state = next;
  fillPrefs();
  const provider = activeProvider();
  $('frameBtn').classList.toggle('on', state.frameVisible);
  $('timerBtn').classList.toggle('on', state.timerOpen);
  $('frameShown').checked = state.frameVisible;
  if (!recording) $('hotkey').textContent = state.hotkeyLabel;

  const select = $('provider');
  if (!select.options.length) for (const p of state.providers) select.add(new Option(p.label, p.id));
  select.value = state.provider;
  $('keyRow').hidden = !provider.needsKey;
  $('urlRow').hidden = provider.kind !== 'local';
  $('removeKey').hidden = !provider.hasKey;
  $('keyLink').hidden = !provider.hasKeyPage || provider.hasKey;
  $('key').placeholder = provider.hasKey ? 'Saved' : 'Paste key';
  if (document.activeElement !== $('baseUrl')) $('baseUrl').value = provider.baseUrl;
  setBusy(busy);
}

api.onState(render);
api.state().then(render);
