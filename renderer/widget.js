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

// ---------- maths ----------
// LaTeX in a reply ($…$, $$…$$, \(…\), \[…\]) becomes MathML, which the
// window draws natively. Prices like "$5 and $10" are left alone.

const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=\S)([^$\n]*?\S)\$(?!\d)/g;

function renderMath(tex, display) {
  try {
    return katex.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: true, strict: 'ignore' });
  } catch {
    return `<code class="tex">${escapeHtml(tex)}</code>`;
  }
}

/** While a reply is still arriving, hide maths that has started but not finished. */
function hideOpenMath(text) {
  const masked = text.replace(MATH, (m) => ' '.repeat(m.length));
  let cut = -1;
  for (const opener of ['$$', '\\[', '\\(']) {
    const i = masked.lastIndexOf(opener);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  const lineStart = masked.lastIndexOf('\n') + 1;
  const single = masked.slice(lineStart).search(/\$(?=\S)/);
  if (single >= 0 && (cut < 0 || lineStart + single < cut)) cut = lineStart + single;
  return cut >= 0 ? text.slice(0, cut) : text;
}

function table(rows) {
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => inline(cell.trim()));
  const body = rows.filter((row) => !/^\s*\|?\s*:?-{2,}/.test(row));
  if (!body.length) return '';
  const [head, ...rest] = body;
  return (
    `<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
    `<tbody>${rest.map((row) => `<tr>${cells(row).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  );
}

function markdown(source, done = true) {
  let text = source.replace(/\r/g, '');
  if (!done) text = hideOpenMath(text);
  const maths = [];
  text = text.replace(MATH, (whole, a, b, c, d) => {
    maths.push(renderMath((a ?? b ?? c ?? d).trim(), a != null || b != null));
    return `\u0000${maths.length - 1}\u0000`;
  });
  return markdownBlocks(text).replace(/\u0000(\d+)\u0000/g, (_, i) => maths[Number(i)]);
}

function markdownBlocks(source) {
  const lines = source.split('\n');
  const out = [];
  let paragraph = [];
  let list = null; // 'ul' | 'ol'
  const endParagraph = () => {
    // An equation on its own sits close to its neighbours.
    const equation = paragraph.length === 1 && /^\s*\u0000\d+\u0000\s*$/.test(paragraph[0]);
    if (paragraph.length) out.push(`<p${equation ? ' class="eq"' : ''}>${paragraph.map(inline).join('<br>')}</p>`);
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
    if (/^\s*\|.*\|\s*$/.test(line)) {
      endParagraph();
      endList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i -= 1;
      out.push(table(rows));
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (heading) {
      endParagraph();
      endList();
      out.push(`<h4>${inline(heading[1])}</h4>`);
    } else if (bullet || numbered) {
      endParagraph();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        endList();
        // A numbered list split by an equation carries on from its own number.
        const start = numbered && numbered[1] !== '1' ? ` start="${Number(numbered[1])}"` : '';
        out.push(`<${kind}${start}>`);
        list = kind;
      }
      out.push(`<li>${inline(bullet ? bullet[1] : numbered[2])}</li>`);
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
  const text = raw.replace(/<candidates>[\s\S]*?(?:<\/candidates>|$)/i, '').replace(/<\/?[a-z]*$/i, '');
  const answer = text.match(/<answer>\s*([\s\S]*?)\s*(?:<\/answer>|<explain>|<working>|$)/i);
  const explain = text.match(/<explain>\s*([\s\S]*?)\s*(?:<\/explain>|<working>|$)/i);
  const working = text.match(/<working>\s*([\s\S]*?)\s*(?:<\/working>|$)/i);
  const part = (match) => (match ? match[1].trim() : '');
  if (answer || explain || working) return { answer: part(answer), explain: part(explain), working: part(working) };
  const plain = text.trim();
  if (!done) return { answer: plain, explain: '', working: '' };
  // The model ignored the format: the first paragraph is the answer, the rest the working.
  const [first, ...rest] = plain.split(/\n\s*\n/);
  return { answer: (first || '').trim(), explain: '', working: rest.join('\n\n').trim() };
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
// A toast slides in, swaps its words softly when a new one comes, and fades out (never blinks).
function toast(message) {
  const el = $('toast');
  clearTimeout(toastTimer);
  el.classList.remove('leaving');
  if (!el.hidden && el.textContent !== message) {
    el.classList.remove('swap');
    void el.offsetWidth; // restart the animation
    el.classList.add('swap');
  }
  el.textContent = message;
  el.hidden = false;
  toastTimer = setTimeout(hideToast, 4500);
}

function hideToast() {
  const el = $('toast');
  if (el.hidden) return;
  clearTimeout(toastTimer);
  el.classList.add('leaving');
  toastTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove('leaving', 'swap');
  }, 280);
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
  const explain = disclosure('How to get there', 'showExplain', 'explain');
  const working = disclosure('Working out', 'showWorking');
  const thinking = disclosure('Thinking', 'showThinking', 'thinking');
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.innerHTML =
    `<button class="ghost retry">${icon('M13.25 8a5.25 5.25 0 1 1-1.55-3.7M13.25 2.75v2.5h-2.5')}<span>Wrong answer</span></button>` +
    `<button class="ghost fill">${icon('M4 2.75 12.25 8l-3.6.85 2 4.15-1.5.7-2-4.15L4 12.25Z')}<span>Fill in</span></button>` +
    `<button class="ghost copy">${icon('M5.5 5.5V3.75c0-.7.55-1.25 1.25-1.25h5.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25H10.5M3.75 5.5h5.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25h-5.5c-.7 0-1.25-.55-1.25-1.25v-5.5c0-.7.55-1.25 1.25-1.25Z')}<span>Copy</span></button>`;
  el.append(answer, explain.wrap, working.wrap, thinking.wrap, actions);
  thread.appendChild(el);

  const c = { el, answer, explain, working, thinking, actions, text: '', thoughts: '', done: false, shown: false, parts: { answer: '' } };
  actions.querySelector('.retry').addEventListener('click', () => {
    if (!busy && live && c === lastCard) api.retry();
  });
  actions.querySelector('.fill').addEventListener('click', () => {
    if (!busy && live && c === lastCard) api.fill();
  });
  actions.querySelector('.copy').addEventListener('click', (event) => {
    api.copy(c.parts.answer);
    const label = event.currentTarget.querySelector('span');
    label.textContent = 'Copied';
    setTimeout(() => (label.textContent = 'Copy'), 1400);
  });
  if (lastCard) for (const b of lastCard.actions.querySelectorAll('.retry, .fill')) b.hidden = true;
  lastCard = c;
  paint(c);
  return c;
}

function paint(c) {
  c.parts = splitReply(c.text, c.done);
  const { answer, explain, working } = c.parts;
  if (answer) {
    const reveal = !c.shown;
    c.shown = true;
    const visible = answer.replace(/\\[a-z]+|[{}$^_\\]/gi, '').length; // what shows, not the LaTeX behind it
    c.answer.className = `answer${visible > 140 ? ' long' : ''}${reveal ? ' reveal' : ''}`;
    c.answer.innerHTML = markdown(answer, c.done);
  } else if (c.done) {
    c.answer.className = 'answer quiet';
    c.answer.textContent = 'No answer came back.';
  } else if (!c.answer.querySelector('.dots')) {
    c.answer.className = 'answer';
    c.answer.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  }
  c.explain.wrap.hidden = !explain;
  if (explain) c.explain.body.innerHTML = markdown(explain, c.done);
  c.working.wrap.hidden = !working;
  if (working) c.working.body.innerHTML = markdown(working, c.done);
  c.thinking.wrap.hidden = !c.thoughts.trim();
  if (c.thoughts) c.thinking.body.textContent = c.thoughts.trim();
  c.actions.hidden = !(c.done && answer);
  c.actions.querySelector('.retry').hidden = !(live && c === lastCard);
  c.actions.querySelector('.fill').hidden = !(live && c === lastCard);
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

// The reply started over: it went in circles, or only repeated a wrong answer.
api.onRethink((reason) => {
  if (!card) return;
  Object.assign(card, { text: '', thoughts: '', shown: false });
  paint(card);
  toast(
    reason === 'repeat'
      ? 'Same answer as before. Looking for a different one.'
      : 'It was going in circles, so it started over with a shorter think.',
  );
});

api.onToast((message) => toast(message));

// Wrong answer picked one of the model's other answers: show that one.
api.onReplace((reply) => {
  if (!card) return;
  card.text = reply;
  card.shown = false;
  paint(card);
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
  setBusy(autoRunning); // a new answer asked for by Check result comes mid-run
}

api.onDone(finish);

// Fill in and the steps: the Answer button turns into Stop until they finish.
let autoRunning = false;
const RUN_TOASTS = ['Filling in. Press Esc to stop.', 'Running your blocks. Press Esc to stop.'];
api.onAuto((run) => {
  autoRunning = run.on;
  setBusy(run.on);
  markRunning(run.on && run.kind === 'steps' ? run.index : -1);
  if (run.on) {
    if (run.index == null) toast(run.kind === 'fill' ? RUN_TOASTS[0] : RUN_TOASTS[1]);
  } else if (run.error) toast(run.error);
  else if (run.stopped) toast('Stopped.');
  else if (run.kind === 'fill' && !run.result) toast('Nothing to fill in here.');
  else if (RUN_TOASTS.includes($('toast').textContent)) hideToast(); // keep anything said during the run
});

// A block that is waiting shows the time left in place of its summary.
let waitTimer = null;
const timeLeft = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`;
};
api.onWait(({ index, until }) => {
  clearInterval(waitTimer);
  const el = $('blocks').children[index];
  const sum = el && el.querySelector('.bsum');
  const step = steps && steps.list[index];
  if (!sum || !step) return;
  if (!until) {
    sum.textContent = summary(step);
    return;
  }
  const tick = () => (sum.textContent = `${step.type === 'repeat' ? 'Next in' : 'Waiting'} ${timeLeft(until - Date.now())}`);
  tick();
  waitTimer = setInterval(tick, 250);
});

api.onVerdict(({ result, attempt }) => {
  if (result === 'right') toast(attempt ? 'Right this time.' : 'Marked right.');
  else if (result === 'wrong') toast('Marked wrong.');
});

api.onSpeak((words) => {
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(words));
});

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
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** A thin white bar: a share when the size is known, a sweep while waiting. */
function showProgress(prefix, progress) {
  const row = $(`${prefix}Row`);
  const bar = row.querySelector('.bar');
  row.hidden = false;
  if (progress && progress.total) {
    const share = Math.min(100, (progress.done / progress.total) * 100);
    bar.classList.remove('waiting');
    $(`${prefix}Fill`).style.width = `${share}%`;
    $(`${prefix}Text`).textContent = `${Math.floor(share)}% of ${formatBytes(progress.total)}`;
  } else {
    bar.classList.add('waiting');
    $(`${prefix}Text`).textContent = (progress && progress.label) || 'Starting…';
  }
}

function hideProgress(prefix) {
  $(`${prefix}Row`).hidden = true;
  $(`${prefix}Fill`).style.width = '0';
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

// Downloading a local model

const DOWNLOAD_ICON = '<svg viewBox="0 0 16 16"><path d="M8 2.75v8M4.5 7.5 8 11l3.5-3.5M3 13.25h10" /></svg>';
const STOP_ICON = '<svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6" /></svg>';
let downloadingModel = false;

function setDownloading(on) {
  downloadingModel = on;
  $('downloadBtn').innerHTML = on ? STOP_ICON : DOWNLOAD_ICON;
  $('downloadBtn').title = on ? 'Stop' : 'Download';
  $('downloadName').disabled = on;
  $('provider').disabled = on;
}

async function startModelDownload() {
  if (downloadingModel) return api.stopDownload();
  const name = $('downloadName').value.trim() || $('downloadName').placeholder;
  if (!name) return;
  const providerId = state.provider;
  note('');
  setDownloading(true);
  showProgress('download', null);
  const result = await api.download(providerId, name);
  setDownloading(false);
  hideProgress('download');
  if (!result.ok) {
    if (!result.stopped) note(result.error);
    return;
  }
  $('downloadName').value = '';
  render(result.state);
  toast(`${name} is ready.`);
  refreshModels();
}

$('downloadBtn').addEventListener('click', startModelDownload);
$('downloadName').addEventListener('keydown', (event) => event.key === 'Enter' && startModelDownload());
api.onDownload((progress) => {
  if (!downloadingModel) return;
  if (progress.total) return showProgress('download', progress);
  showProgress('download', { label: /verif|writ|success/i.test(progress.status || '') ? 'Finishing…' : 'Starting…' });
});

// Updates: only when pressed.

let updateFound = null;
const updateBtn = $('updateBtn');

updateBtn.addEventListener('click', async () => {
  if (updateBtn.disabled) return;
  if (!updateFound) {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Checking…';
    const result = await api.checkUpdate();
    updateBtn.disabled = false;
    if (!result || !result.ok) {
      updateBtn.textContent = 'Check for updates';
      return toast(result ? result.error : "Couldn't check for updates.");
    }
    if (!result.available) {
      updateBtn.textContent = 'Up to date';
      setTimeout(() => !updateFound && (updateBtn.textContent = 'Check for updates'), 2500);
      return;
    }
    updateFound = result;
    updateBtn.textContent = `Update to ${result.version}`;
    return;
  }
  updateBtn.disabled = true;
  updateBtn.textContent = 'Downloading update…';
  showProgress('update', { done: 0, total: updateFound.size });
  const result = await api.installUpdate();
  if (!result || !result.ok) {
    updateBtn.disabled = false;
    updateBtn.textContent = `Update to ${updateFound.version}`;
    hideProgress('update');
    toast(result ? result.error : "Couldn't update.");
  }
});

api.onUpdate((progress) => {
  if (progress.installing) {
    updateBtn.textContent = 'Restarting…';
    showProgress('update', { label: 'Installing…' });
  } else showProgress('update', progress);
});

for (const input of [$('baseUrl'), $('key')]) {
  input.addEventListener('keydown', (event) => event.key === 'Enter' && input.blur());
}

// ---------- steps: blocks that run after an answer ----------

const PATHS = {
  fill: 'M4 2.75 12.25 8l-3.6.85 2 4.15-1.5.7-2-4.15L4 12.25Z',
  click: 'M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5',
  find: 'M7 2.75a4.25 4.25 0 1 1 0 8.5 4.25 4.25 0 0 1 0-8.5ZM10.2 10.2l3.3 3.3',
  type: 'M3.5 4.5h9M8 4.5v8M6.25 12.5h3.5',
  keys: 'M2.5 4.5h11v7h-11ZM5 7h.01M8 7h.01M11 7h.01M5.5 9.25h5',
  wait: 'M4.5 2.5h7M4.5 13.5h7M5.5 2.5c0 3 5 3.25 5 5.5s-5 2.5-5 5.5M10.5 2.5c0 3-5 3.25-5 5.5s5 2.5 5 5.5',
  scroll: 'M8 2.5v11M5.25 5.25 8 2.5l2.75 2.75M5.25 10.75 8 13.5l2.75-2.75',
  copy: 'M5.5 5.5V3.75c0-.7.55-1.25 1.25-1.25h5.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25H10.5M3.75 5.5h5.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25h-5.5c-.7 0-1.25-.55-1.25-1.25v-5.5c0-.7.55-1.25 1.25-1.25Z',
  speak: 'M3 6.25h2.5L9 3.5v9L5.5 9.75H3ZM11.25 5.75a3 3 0 0 1 0 4.5M12.75 4a5.5 5.5 0 0 1 0 8',
  mouse: 'M6 4.5 3 7.5l3 3M3.25 7.5H10a3 3 0 0 1 0 6H8.5',
  verify: 'M5.4 8.2 7.15 9.9l3.45-3.8M8 2.25a5.75 5.75 0 1 1 0 11.5 5.75 5.75 0 0 1 0-11.5Z',
  repeat: 'M2.75 8a5.25 5.25 0 0 1 9.4-3.2M13.25 8a5.25 5.25 0 0 1-9.4 3.2M12.5 2.25v2.9H9.6M3.5 13.75v-2.9h2.9',
};

const BLOCKS = [
  { type: 'fill', title: 'Fill in', hint: 'Puts the answer into the question' },
  { type: 'click', title: 'Click', hint: 'Point at a button once, found again each time' },
  { type: 'find', title: 'Click by name', hint: 'Finds a button by its words, like Next' },
  { type: 'verify', title: 'Check result', hint: 'Reads if it was marked right, and tries again if not' },
  { type: 'repeat', title: 'Keep going', hint: 'Answers the next question too, on a timer if you like' },
  { type: 'type', title: 'Type', hint: 'Types the answer or your own text' },
  { type: 'keys', title: 'Press keys', hint: 'Enter, Tab or any shortcut' },
  { type: 'wait', title: 'Wait', hint: 'Pauses before the next block' },
  { type: 'scroll', title: 'Scroll', hint: 'Scrolls inside the frame' },
  { type: 'copy', title: 'Copy answer', hint: 'Puts the answer on the clipboard' },
  { type: 'speak', title: 'Read aloud', hint: 'Says the answer out loud' },
  { type: 'mouse', title: 'Mouse back', hint: 'Puts the mouse back where it was' },
];
const BLOCK = Object.fromEntries(BLOCKS.map((b) => [b.type, b]));
const DEFAULT_STEP = {
  click: { at: null, target: null, adaptive: true, button: 'left', settle: true },
  find: { text: '', where: 'frame', settle: true },
  type: { source: 'answer', text: '', at: null, target: null },
  keys: { keys: 'Enter' },
  wait: { seconds: 1, unit: 'sec' },
  verify: { onWrong: 'retry', tries: 2 },
  repeat: { count: 10, seconds: 0, unit: 'sec' },
  scroll: { direction: 'down', amount: 3 },
};

let steps = null; // { on, list }, owned here once loaded; every change is saved
let openStep = null; // the block that shows its settings
let keysFor = null; // the Press keys block that is listening for keys

const svg = (d) => `<svg viewBox="0 0 16 16"><path d="${d}"/></svg>`;
const keyLabel = (accelerator) => accelerator.replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win').split('+').join(' + ');

const KIND_WORDS = {
  button: 'button',
  splitbutton: 'button',
  hyperlink: 'link',
  menuitem: 'menu item',
  tabitem: 'tab',
  listitem: 'item',
  treeitem: 'item',
  radiobutton: 'option',
  checkbox: 'check box',
  edit: 'text box',
  combobox: 'drop-down',
  document: 'text box',
  spinner: 'number box',
};

/** What a Click block points at: “Next” · button, or what it looks like. */
function targetLabel(target) {
  if (target.type === 'look') return target.name;
  const kind = KIND_WORDS[target.type];
  return kind ? `“${target.name}” · ${kind}` : `“${target.name}”`;
}

/** Seconds as the block shows them: "90 s" or "1.5 min". */
const duration = (seconds, unit) =>
  unit === 'min' ? `${Math.round((seconds / 60) * 100) / 100} min` : `${seconds} s`;

function summary(step) {
  switch (step.type) {
    case 'click': {
      if (!step.at) return 'Point at it';
      const how = step.button === 'double' ? 'Double · ' : step.button === 'right' ? 'Right · ' : '';
      return how + (step.adaptive && step.target ? targetLabel(step.target) : 'This exact spot');
    }
    case 'find':
      return step.text ? `“${step.text}”` : 'Set the text';
    case 'type':
      return step.source === 'custom' ? (step.text ? `“${step.text}”` : 'Set the text') : 'The answer';
    case 'keys':
      return keyLabel(step.keys);
    case 'wait':
      return duration(step.seconds, step.unit);
    case 'verify':
      return step.onWrong === 'retry' ? `If wrong, ${step.tries} more ${step.tries === 1 ? 'try' : 'tries'}` : step.onWrong === 'stop' ? 'If wrong, stop' : 'If wrong, go on';
    case 'repeat':
      return `${step.count} more${step.seconds ? ` · ${duration(step.seconds, step.unit)} apart` : ''}`;
    case 'scroll':
      return `${step.direction === 'up' ? 'Up' : 'Down'} ${step.amount}`;
    default:
      return '';
  }
}

let saveTimer = null;
/** Save the blocks soon. Any change to them (not just to the presets) ends the chance to undo a preset. */
function saveSteps(presetsOnly = false) {
  if (!presetsOnly) setUndo(null);
  $('stepsSum').textContent = steps.list.length ? `then ${steps.list.length} block${steps.list.length === 1 ? '' : 's'}` : 'add blocks below';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api.setSteps(steps);
  }, 200);
}

function refreshSummary(step) {
  const el = $('blocks').querySelector(`[data-id="${step.id}"] .bsum`);
  if (el) el.textContent = summary(step);
}

/** A small segmented control. */
function segment(options, value, onPick) {
  const box = document.createElement('div');
  box.className = 'seg';
  for (const [key, label] of options) {
    const button = document.createElement('button');
    button.textContent = label;
    button.classList.toggle('on', key === value);
    button.addEventListener('click', () => {
      for (const other of box.children) other.classList.toggle('on', other === button);
      onPick(key);
    });
    box.appendChild(button);
  }
  return box;
}

function row(label, ...controls) {
  const el = document.createElement('div');
  el.className = 'brow';
  const name = document.createElement('span');
  name.textContent = label;
  el.append(name, ...controls);
  return el;
}

function textField(value, placeholder, onInput) {
  const field = document.createElement('input');
  field.type = 'text';
  field.value = value;
  field.placeholder = placeholder;
  field.spellcheck = false;
  field.addEventListener('input', () => onInput(field.value));
  field.addEventListener('keydown', (event) => event.key === 'Enter' && field.blur());
  return field;
}

/** Point at something on screen. Clicks and typing also learn what is there, to find it again later. */
function spotPicker(step, emptyLabel, onPicked = () => {}) {
  const box = document.createElement('div');
  box.className = 'spot';
  const value = document.createElement('span');
  const pick = document.createElement('button');
  pick.className = 'pill-button';
  const show = () => {
    if (step.target) value.textContent = targetLabel(step.target);
    else if (step.at) value.textContent = step.type === 'click' ? 'This exact spot' : `${step.at.x}, ${step.at.y}`;
    else value.textContent = emptyLabel;
    value.title = value.textContent;
    value.classList.toggle('unset', !step.at);
    pick.textContent = step.at ? 'Point again' : 'Point';
  };
  pick.addEventListener('click', async () => {
    pick.disabled = true;
    pick.textContent = 'Pointing…';
    const picked = await api.pickSpot(step.type);
    pick.disabled = false;
    if (picked) {
      step.at = picked.at;
      step.target = picked.target;
      saveSteps();
      refreshSummary(step);
      onPicked();
    }
    show();
  });
  box.append(value, pick);
  if (step.type === 'type') {
    const clear = document.createElement('button');
    clear.className = 'mini';
    clear.title = 'Type where the cursor is';
    clear.setAttribute('aria-label', 'Type where the cursor is');
    clear.innerHTML = svg('M5 5l6 6M11 5l-6 6');
    clear.addEventListener('click', () => {
      step.at = null;
      step.target = null;
      saveSteps();
      show();
    });
    box.appendChild(clear);
  }
  show();
  return box;
}

/** After a click, wait for the page to change (the next question coming in) before going on. */
function settleRow(step, changed) {
  const label = document.createElement('span');
  label.className = 'grow';
  label.textContent = 'Wait for the page';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'switch';
  toggle.checked = step.settle !== false;
  toggle.setAttribute('aria-label', 'Wait for the page to change');
  toggle.addEventListener('change', () => {
    step.settle = toggle.checked;
    changed();
  });
  return row('Then', label, toggle);
}

/** A length of time in seconds or minutes (up to an hour), kept in step.seconds. */
function timeField(step, least, changed) {
  const field = document.createElement('input');
  field.type = 'number';
  const show = () => {
    const min = step.unit === 'min';
    field.min = String(min ? 0 : least);
    field.max = min ? '60' : '3600';
    field.step = min ? '0.5' : least ? '0.5' : '1';
    field.value = String(min ? Math.round((step.seconds / 60) * 100) / 100 : step.seconds);
  };
  field.addEventListener('change', () => {
    const value = Number(field.value) || 0;
    const seconds = step.unit === 'min' ? value * 60 : value;
    step.seconds = Math.min(3600, Math.max(least, Math.round(seconds * 10) / 10));
    show();
    changed();
  });
  show();
  const unit = segment([['sec', 'sec'], ['min', 'min']], step.unit || 'sec', (v) => {
    step.unit = v;
    show();
    changed();
  });
  unit.classList.add('units');
  return [field, unit];
}

function blockBody(step) {
  const body = document.createElement('div');
  body.className = 'block-body';
  const changed = () => {
    saveSteps();
    refreshSummary(step);
  };
  switch (step.type) {
    case 'fill':
    case 'copy':
    case 'speak':
    case 'mouse': {
      const note = document.createElement('p');
      note.className = 'bnote';
      note.textContent = BLOCK[step.type].hint + '.';
      body.appendChild(note);
      break;
    }
    case 'click': {
      const findRow = row(
        'Find',
        segment([['each', 'Each time'], ['spot', 'Same spot']], step.adaptive ? 'each' : 'spot', (v) => {
          step.adaptive = v === 'each';
          changed();
        }),
      );
      findRow.hidden = !step.target;
      body.append(
        row(
          'What',
          spotPicker(step, 'Not set', () => {
            findRow.hidden = !step.target;
            queueMeasure();
          }),
        ),
        findRow,
        row('Click', segment([['left', 'Left'], ['double', 'Double'], ['right', 'Right']], step.button, (v) => ((step.button = v), changed()))),
        settleRow(step, changed),
      );
      break;
    }
    case 'find':
      body.append(
        row('Text', textField(step.text, 'Next', (v) => ((step.text = v.slice(0, 80)), changed()))),
        row('Look', segment([['frame', 'In the frame'], ['screen', 'Whole screen']], step.where, (v) => ((step.where = v), changed()))),
        settleRow(step, changed),
      );
      break;
    case 'type': {
      const custom = textField(step.text, 'Text to type', (v) => ((step.text = v.slice(0, 500)), changed()));
      const customRow = row('Text', custom);
      customRow.hidden = step.source !== 'custom';
      body.append(
        row('Type', segment([['answer', 'The answer'], ['custom', 'Text']], step.source, (v) => {
          step.source = v;
          customRow.hidden = v !== 'custom';
          changed();
          queueMeasure();
        })),
        customRow,
        row('Where', spotPicker(step, 'Where the cursor is')),
      );
      break;
    }
    case 'keys': {
      const cap = document.createElement('button');
      cap.className = 'keycap';
      cap.textContent = keyLabel(step.keys);
      cap.addEventListener('click', () => {
        const listening = keysFor === step;
        keysFor = listening ? null : step;
        cap.classList.toggle('recording', !listening);
        cap.textContent = listening ? keyLabel(step.keys) : 'Press keys…';
        cap.dataset.listen = String(!listening);
      });
      body.append(row('Keys', cap));
      break;
    }
    case 'wait':
      body.append(row('Wait', ...timeField(step, 0.1, changed)));
      break;
    case 'verify': {
      const tries = row('Tries', segment([['1', '1'], ['2', '2'], ['3', '3']], String(step.tries), (v) => ((step.tries = Number(v)), changed())));
      tries.hidden = step.onWrong !== 'retry';
      const note = document.createElement('p');
      note.className = 'bnote';
      note.textContent = 'Put it after the block that checks the answer.';
      body.append(
        note,
        row('If wrong', segment([['retry', 'Try again'], ['continue', 'Go on'], ['stop', 'Stop']], step.onWrong, (v) => {
          step.onWrong = v;
          tries.hidden = v !== 'retry';
          changed();
          queueMeasure();
        })),
        tries,
      );
      break;
    }
    case 'repeat': {
      const count = document.createElement('input');
      count.type = 'number';
      count.min = '1';
      count.max = '500';
      count.value = String(step.count);
      count.addEventListener('change', () => {
        step.count = Math.min(500, Math.max(1, Math.round(Number(count.value) || 10)));
        count.value = String(step.count);
        changed();
      });
      const more = document.createElement('span');
      more.className = 'unit';
      more.textContent = 'more questions';
      const note = document.createElement('p');
      note.className = 'bnote';
      note.textContent = 'Put it last. Stops when the page stops changing, or on Esc.';
      body.append(note, row('Answer', count, more), row('Wait', ...timeField(step, 0, changed)));
      break;
    }
    case 'scroll': {
      const amount = document.createElement('input');
      amount.type = 'number';
      amount.min = '1';
      amount.max = '30';
      amount.value = String(step.amount);
      amount.addEventListener('change', () => {
        step.amount = Math.min(30, Math.max(1, Math.round(Number(amount.value) || 3)));
        amount.value = String(step.amount);
        changed();
      });
      body.append(
        row('Way', segment([['down', 'Down'], ['up', 'Up']], step.direction, (v) => ((step.direction = v), changed()))),
        row('Amount', amount),
      );
      break;
    }
  }
  return body;
}

// Recording keys for a Press keys block: anything goes, including plain Enter or Esc.
window.addEventListener(
  'keydown',
  (event) => {
    if (!keysFor) return;
    event.preventDefault();
    event.stopPropagation();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
    let key = null;
    if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
    else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
    else if (/^F\d{1,2}$/.test(event.code)) key = event.code;
    else if (event.code === 'Escape') key = 'Escape';
    else if (event.code === 'Backspace') key = 'Backspace';
    else key = KEY_NAMES[event.code] || null;
    if (!key) return;
    const mods = [];
    if (event.ctrlKey) mods.push('Control');
    if (event.altKey) mods.push('Alt');
    if (event.shiftKey) mods.push('Shift');
    if (event.metaKey) mods.push('Super');
    const step = keysFor;
    keysFor = null;
    step.keys = [...mods, key].join('+');
    saveSteps();
    refreshSummary(step);
    const cap = $('blocks').querySelector(`[data-id="${step.id}"] .keycap`);
    if (cap) {
      cap.classList.remove('recording');
      cap.textContent = keyLabel(step.keys);
    }
  },
  true,
);

function blockElement(step) {
  const el = document.createElement('div');
  el.className = `block${openStep === step.id ? ' open' : ''}`;
  el.dataset.id = step.id;
  el.innerHTML = `
    <div class="block-head">
      <span class="grip" title="Drag to move"><svg viewBox="0 0 10 14"><circle cx="3" cy="3" r="1.1"/><circle cx="7" cy="3" r="1.1"/><circle cx="3" cy="7" r="1.1"/><circle cx="7" cy="7" r="1.1"/><circle cx="3" cy="11" r="1.1"/><circle cx="7" cy="11" r="1.1"/></svg></span>
      <span class="bicon">${svg(PATHS[step.type])}</span>
      <span class="btitle"></span>
      <span class="bsum"></span>
      <button class="mini remove" title="Remove" aria-label="Remove block">${svg('M5 5l6 6M11 5l-6 6')}</button>
    </div>
    <div class="fold"></div>`;
  el.querySelector('.btitle').textContent = BLOCK[step.type].title;
  el.querySelector('.bsum').textContent = summary(step);
  el.querySelector('.fold').appendChild(blockBody(step));
  el.querySelector('.block-head').addEventListener('click', (event) => {
    if (event.target.closest('.grip, .remove')) return;
    const open = !el.classList.contains('open');
    for (const other of $('blocks').children) other.classList.toggle('open', other === el && open);
    openStep = open ? step.id : null;
  });
  el.querySelector('.remove').addEventListener('click', () => {
    steps.list = steps.list.filter((s) => s !== step);
    if (keysFor === step) keysFor = null;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
    saveSteps();
  });
  dragToMove(el, el.querySelector('.grip'));
  return el;
}

/** Drag a block by its grip; the others glide out of the way. */
function dragToMove(el, grip) {
  let drag = null;
  const glide = (other, from) => {
    const shift = from - other.getBoundingClientRect().top;
    other.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], {
      duration: 220,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    });
  };
  const move = (event) => {
    if (!drag) return;
    const box = $('blocks');
    const list = [...box.children].filter((child) => !child.classList.contains('leaving'));
    const index = list.indexOf(el);
    // Swap when the pointer passes the middle of the block next to it. The
    // neighbour moves, not this block, so the drag never loses hold of it.
    const pointer = event.clientY - box.getBoundingClientRect().top;
    const next = list[index + 1];
    const prev = list[index - 1];
    const swap = (other, otherGoesBefore) => {
      const oldTop = el.offsetTop;
      const otherTop = other.getBoundingClientRect().top;
      if (otherGoesBefore) el.before(other);
      else el.after(other);
      drag.startY += el.offsetTop - oldTop; // keep the block under the pointer
      glide(other, otherTop);
    };
    if (next && pointer > next.offsetTop + next.offsetHeight / 2) swap(next, true);
    else if (prev && pointer < prev.offsetTop + prev.offsetHeight / 2) swap(prev, false);
    el.style.transform = `translateY(${event.clientY - drag.startY}px)`;
  };
  const drop = () => {
    if (!drag) return;
    drag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', drop);
    window.removeEventListener('pointercancel', drop);
    el.classList.remove('dragging');
    el.animate([{ transform: el.style.transform || 'none' }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    el.style.transform = '';
    const order = [...$('blocks').children].map((child) => child.dataset.id);
    steps.list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    saveSteps();
  };
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Folded blocks are easier to move around.
    for (const other of $('blocks').children) other.classList.remove('open');
    openStep = null;
    drag = { startY: event.clientY };
    el.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
  });
}

/** Draw the blocks; new ones rise in one after another. */
function showBlocks(animate = false) {
  const box = $('blocks');
  box.textContent = '';
  steps.list.forEach((step, i) => {
    const el = blockElement(step);
    if (animate) {
      el.classList.add('entering');
      el.style.animationDelay = `${i * 45}ms`;
    }
    box.appendChild(el);
  });
}

function renderBlocks() {
  if (!Array.isArray(steps.presets)) steps.presets = [];
  showBlocks();
  $('stepsOn').checked = steps.on;
  saveSteps();
  clearTimeout(saveTimer); // nothing changed yet
  saveTimer = null;
}

function markRunning(index) {
  [...$('blocks').children].forEach((el, i) => el.classList.toggle('running', i === index));
}

// The add menu: every kind of block, two to a row.
for (const kind of BLOCKS) {
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.title = kind.hint;
  item.innerHTML = `${svg(PATHS[kind.type])}<span></span>`;
  item.querySelector('span').textContent = kind.title;
  item.addEventListener('click', () => {
    if (steps.list.length >= 24) return toast('That is the most blocks there can be.');
    const step = { id: Math.random().toString(36).slice(2, 10), type: kind.type, ...structuredClone(DEFAULT_STEP[kind.type] || {}) };
    steps.list.push(step);
    // Blocks with settings open straight away.
    openStep = DEFAULT_STEP[kind.type] ? step.id : null;
    for (const other of $('blocks').children) other.classList.remove('open');
    const el = blockElement(step);
    el.classList.add('entering');
    $('blocks').appendChild(el);
    setPanel(null);
    saveSteps();
    requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });
  $('blockMenu').appendChild(item);
}

/** Open the add menu ('add'), the presets ('presets'), or neither. */
function setPanel(which) {
  const add = $('addBlock').closest('.add');
  if (which === 'presets') renderPresets();
  add.classList.toggle('open', which === 'add');
  add.classList.toggle('presets', which === 'presets');
  $('addBlock').setAttribute('aria-expanded', String(which === 'add'));
  $('presetsBtn').setAttribute('aria-expanded', String(which === 'presets'));
}

$('addBlock').addEventListener('click', () => setPanel($('addBlock').getAttribute('aria-expanded') === 'true' ? null : 'add'));
$('presetsBtn').addEventListener('click', () => setPanel($('presetsBtn').getAttribute('aria-expanded') === 'true' ? null : 'presets'));

// ---------- presets: ready-made sets of blocks, and your own ----------

const READY_PRESETS = [
  {
    name: 'Answer them all',
    list: [{ type: 'fill' }, { type: 'find', text: 'Check', where: 'screen' }, { type: 'verify' }, { type: 'find', text: 'Next', where: 'screen' }, { type: 'repeat' }],
  },
  { name: 'Fill in, check, next', list: [{ type: 'fill' }, { type: 'find', text: 'Check', where: 'screen' }, { type: 'verify' }, { type: 'find', text: 'Next', where: 'screen' }] },
  { name: 'Fill in, then next', list: [{ type: 'fill' }, { type: 'find', text: 'Next', where: 'screen' }] },
  { name: 'Fill in and submit', list: [{ type: 'fill' }, { type: 'find', text: 'Submit', where: 'screen' }] },
  { name: 'Type it and press Enter', list: [{ type: 'type' }, { type: 'keys', keys: 'Enter' }] },
  { name: 'Copy the answer', list: [{ type: 'copy' }] },
  { name: 'Read it aloud', list: [{ type: 'speak' }] },
];
const MAX_PRESETS = 20;

const newId = () => Math.random().toString(36).slice(2, 10);
/** Fresh copies of a preset's blocks, with every setting filled in. */
const blocksOf = (list) => list.map((block) => ({ ...structuredClone(DEFAULT_STEP[block.type] || {}), ...structuredClone(block), id: newId() }));

let undoList = null;
let undoTimer = null;
function setUndo(list) {
  undoList = list;
  clearTimeout(undoTimer);
  $('undoPreset').hidden = !list;
  if (list) undoTimer = setTimeout(() => setUndo(null), 10000);
}

function loadPreset(preset) {
  const before = steps.list;
  steps.list = blocksOf(preset.list);
  openStep = null;
  keysFor = null;
  setPanel(null);
  showBlocks(true);
  saveSteps();
  setUndo(before.length ? before : null); // the blocks it replaced can come back
}

function presetElement(preset, saved) {
  const row = document.createElement('div');
  row.className = 'preset';
  const load = document.createElement('button');
  load.className = 'preset-load';
  const icons = document.createElement('span');
  icons.className = 'preset-icons';
  icons.innerHTML = preset.list
    .slice(0, 3)
    .map((block) => svg(PATHS[block.type]))
    .join('');
  const name = document.createElement('span');
  name.className = 'preset-name';
  name.textContent = preset.name;
  load.append(icons, name);
  load.addEventListener('click', () => loadPreset(preset));
  row.appendChild(load);
  if (saved) {
    const remove = document.createElement('button');
    remove.className = 'mini';
    remove.setAttribute('aria-label', `Remove ${preset.name}`);
    remove.innerHTML = svg('M5 5l6 6M11 5l-6 6');
    remove.addEventListener('click', () => {
      steps.presets = steps.presets.filter((other) => other !== preset);
      saveSteps(true);
      renderPresets();
    });
    row.appendChild(remove);
  }
  return row;
}

/** Name the blocks you have and keep them as a preset. A name already used is updated. */
function saveRow() {
  const row = document.createElement('div');
  row.className = 'preset-save';
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Name these blocks';
  name.maxLength = 40;
  name.spellcheck = false;
  const save = document.createElement('button');
  save.className = 'pill-button';
  save.textContent = 'Save';
  const update = () => (save.disabled = !name.value.trim() || !steps.list.length);
  name.addEventListener('input', update);
  name.addEventListener('keydown', (event) => event.key === 'Enter' && !save.disabled && save.click());
  save.addEventListener('click', () => {
    const title = name.value.trim().slice(0, 40);
    const same = steps.presets.find((preset) => preset.name.toLowerCase() === title.toLowerCase());
    if (!same && steps.presets.length >= MAX_PRESETS) return toast('That is the most presets there can be.');
    const list = structuredClone(steps.list);
    if (same) same.list = list;
    else steps.presets.push({ id: newId(), name: title, list });
    saveSteps(true);
    renderPresets();
    toast(same ? `Updated “${title}”.` : `Saved “${title}”.`);
  });
  update();
  row.append(name, save);
  return row;
}

function renderPresets() {
  const menu = $('presetMenu');
  menu.textContent = '';
  for (const preset of READY_PRESETS) menu.appendChild(presetElement(preset, false));
  if (steps.presets.length) {
    const label = document.createElement('div');
    label.className = 'preset-label';
    label.textContent = 'Saved';
    menu.appendChild(label);
    for (const preset of steps.presets) menu.appendChild(presetElement(preset, true));
  }
  menu.appendChild(saveRow());
}

$('undoPreset').addEventListener('click', () => {
  if (!undoList) return;
  steps.list = undoList;
  setUndo(null);
  showBlocks(true);
  saveSteps();
});
$('stepsOn').addEventListener('change', () => {
  steps.on = $('stepsOn').checked;
  saveSteps();
});
$('runSteps').addEventListener('click', () => {
  if (!steps.list.length) return toast('Add a block first.');
  if (busy) return;
  // A change still waiting to be saved goes first, so the run uses it.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    api.setSteps(steps);
  }
  api.runSteps();
});

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
  $('downloadBox').hidden = provider.kind !== 'local';
  const suggestions = (state.suggestedDownloads && state.suggestedDownloads[provider.id]) || [];
  $('downloadName').placeholder = suggestions[0] || '';
  $('downloadList').textContent = '';
  for (const name of suggestions) $('downloadList').append(new Option(name));
  $('versionInfo').textContent = state.version;
  if (!steps && state.steps) {
    steps = structuredClone(state.steps);
    renderBlocks();
  }
  setBusy(busy);
}

api.onState(render);
api.state().then(render);
