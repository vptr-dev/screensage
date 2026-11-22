const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { PROVIDERS, SUGGESTED_DOWNLOADS, AppError, chat, listModels, suggestModel, downloadModel } = require('./providers');
const crypto = require('crypto');
const { spawn } = require('child_process');
const input = require('./input');
const { toPlain } = require('./plain');

// The widget is a fixed width; its height follows what it is showing.
const WIDGET = { width: 320, minHeight: 60, maxHeight: 580, margin: 14 };
const TIMER = { width: 214, height: 52 };
// The frame is the capture area itself (screen coordinates). Its edge, handles
// and toolbar are drawn just outside it, so they never end up in the picture.
const HOLE_MIN = { width: 80, height: 48 };
const MAX_IMAGE_WIDTH = 1600;
const OVERLAY_OPACITY = 0.99;
const MAX_HISTORY = 50;
// Bumped when the meaning of saved positions changes, so old ones are dropped.
const LAYOUT = 3;

const QUESTION = 'Solve the question shown in this screen capture.';
const RETRY =
  'That answer is wrong. Look at the capture again carefully, work it out from scratch, and give the corrected answer in the same format.';
const systemPrompt = (explain) =>
  [
    'You are looking at a capture of part of the user\'s screen.',
    'Find the question or problem in it and solve it.',
    'Reply in exactly this format, with nothing before or after it:',
    '<answer>',
    'The final answer only: the value, option, word or one short sentence. Only if the capture holds several separate questions, give one answer per line.',
    '</answer>',
    ...(explain
      ? [
          '<explain>',
          'A short lesson so the user can get the same answer on their own: one line saying what the question was really asking, then two to four short steps they can follow, naming any rule, formula or clue that gives it away. Plain, friendly and concise.',
          '</explain>',
        ]
      : []),
    '<working>',
    'How you got the answer, as a few short numbered steps, with the key equation of a step on its own line.',
    '</working>',
    `If there is no question in the capture, put a one-sentence description of what it shows in <answer> and leave ${explain ? 'the other sections' : '<working>'} empty.`,
    'Formatting: write all maths in LaTeX, inline as $...$ and on its own line as $$...$$ (for example $\\frac{3}{4}$, $x^2 + 1$, $\\sqrt{2}$, $45^\\circ$, $3 \\times 4$). Use Markdown for the rest: **bold** for the key value, short numbered steps, a table only when it really helps.',
  ].join('\n');

// Added when a model keeps second-guessing itself and the thinking starts over.
const CALM =
  'Keep your reasoning short and decisive: work it out once, check it once, then give the answer. Do not keep going back over it.';

/** Wrong answer: solve it again from scratch, knowing which answers are wrong. */
const retryNote = (rejected, repeats) =>
  [
    'These answers were checked and marked WRONG, so do not give any of them again:',
    ...rejected.map((a) => `- ${a}`),
    'Trust that they are wrong, even if they look right to you. The question may be trickier than it looks: read the capture again carefully, think about other ways to read it, and solve it from scratch. If it is multiple choice, choose a different option.',
    'In <working>, explain how to get the new answer only; do not talk about the earlier answers or this message.',
    ...(repeats
      ? [
          'You just gave one of the wrong answers again. You must now give an answer that is different from every answer listed above: if you cannot find a better one, give the next most likely answer.',
        ]
      : []),
    ...(repeats >= 2
      ? [
          'Before the usual format, list your three best answers that are NOT marked wrong, best first, one per line, inside <candidates></candidates>. Then put the first of them in <answer>.',
        ]
      : []),
  ].join('\n');

/** The answers a reply listed in <candidates>, best first. */
const candidatesOf = (reply) =>
  ((String(reply).match(/<candidates>([\s\S]*?)<\/candidates>/i) || [])[1] || '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

const withAnswer = (reply, answer) =>
  /<answer>[\s\S]*?<\/answer>/i.test(reply)
    ? reply.replace(/<answer>[\s\S]*?<\/answer>/i, `<answer>\n${answer}\n</answer>`)
    : `<answer>\n${answer}\n</answer>\n${reply}`;

const FILL_ROUNDS = 5;
const KIND_NAMES = {
  edit: 'text box', radiobutton: 'option', checkbox: 'checkbox', combobox: 'dropdown', listitem: 'list item',
  button: 'button', hyperlink: 'link', text: 'text', slider: 'slider', spinner: 'number box', treeitem: 'item', dataitem: 'item',
};
// Buttons that would hand the answer in. Fill in never presses these.
const SUBMIT_WORDS = /\b(submit|next|finish|check|send|done|continue|save|turn in|hand in)\b/i;

function describeElement(e, index) {
  let line = `${index + 1}. ${KIND_NAMES[e.type] || e.type} "${e.name}"`;
  if (e.type === 'edit' || e.type === 'combobox' || e.type === 'spinner') line += ` holding "${e.value}"`;
  if (e.state) line += ` (${e.state})`;
  return line;
}

const fillPrompt = (answer, elements) =>
  [
    'You are entering an answer into the question shown in this screen capture, using the mouse and keyboard.',
    `The answer to enter:\n${toPlain(answer)}`,
    ...(elements.length
      ? [
          'These are the things inside the capture you can use, by number:',
          ...elements.map(describeElement),
          'Reply with commands only, one per line, nothing else. The commands are:',
          '- click N : click thing N (an option, checkbox or list item)',
          '- type N <text> : put <text> into text box N, replacing what is there',
          '- choose N <entry> : pick <entry> in dropdown N',
          '- drag N M : drag thing N onto thing M',
        ]
      : [
          'Positions are on a 0 to 1000 grid over the capture: x across from the left edge, y down from the top edge.',
          'Reply with commands only, one per line, nothing else. The commands are:',
          '- click X Y : click at that position (aim for the centre of the option or box)',
          '- type <text> : type into the box that was just clicked',
          '- drag X1 Y1 X2 Y2 : drag from one position to another',
        ]),
    '- key enter : press a key (enter, tab, down or up)',
    '- look : stop and get a new capture first (for example after opening a custom list)',
    '- done : the answer is fully entered',
    'Rules: only enter the answer, never press submit, next, check or finish. Leave options that are already right alone. Use the answer exactly as given.',
    'An example reply, for a different question:',
    ...(elements.length ? ['type 3 42', 'click 7', 'done'] : ['click 412 388', 'type 42', 'done']),
  ].join('\n');

const DEFAULTS = {
  layout: LAYOUT,
  provider: 'ollama',
  models: {},
  keys: {},
  baseUrls: {},
  frame: null,
  widgetPos: null,
  timerPos: null,
  frameVisible: true,
  frameStyle: { shade: true, shadeStrength: 40 },
  behaviour: { hotkey: 'Control+Shift+Space', closeToTray: false, launchAtLogin: false },
  steps: { on: true, list: [], presets: [] },
  answers: { think: false, explain: false, showExplain: true, showWorking: false, showThinking: false, saveHistory: true },
  timer: { seconds: 300 },
};
const SECTIONS = ['frameStyle', 'behaviour', 'answers', 'timer'];

let widget = null;
let timerWin = null;
let viewer = null;
const overlays = new Set(); // one see-through window per screen, drawing the frame and shade
let tray = null;
let quitting = false;
let hotkeyWorks = true;
let conversation = null;
let session = null; // the capture the conversation is about
let running = null; // AbortController of the answer being written
let filling = null; // AbortController of "Fill in" while it runs
let dragging = false; // the frame is being moved or resized
let selecting = false; // the user is drawing a new frame
let selection = null;
let history = [];

// ---------- files and settings ----------

const dataFile = (name) => path.join(app.getPath('userData'), name);
const capturesDir = () => dataFile('captures');
const settings = structuredClone(DEFAULTS);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 2));
}

const saveSettings = () => writeJson('settings.json', settings);
const saveHistory = () => writeJson('history.json', history);

const clamp = (value, low, high, fallback) =>
  Number.isFinite(Number(value)) ? Math.min(high, Math.max(low, Math.round(Number(value)))) : fallback;
const text = (value, max) => String(value == null ? '' : value).slice(0, max);
const HOTKEY_PATTERN =
  /^((Control|Alt|Shift|Super)\+){0,4}([A-Z0-9]|F([1-9]|1\d|2[0-4])|Space|Enter|Tab|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|[`\-=[\];',./\\])$/;

/** Keep only values the app understands, falling back to what is already set. */
function sanitize(section, patch, current) {
  const p = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  if (section === 'frameStyle') {
    return { shade: !!p.shade, shadeStrength: clamp(p.shadeStrength, 15, 75, current.shadeStrength) };
  }
  if (section === 'behaviour') {
    return {
      hotkey: HOTKEY_PATTERN.test(p.hotkey) ? p.hotkey : current.hotkey,
      closeToTray: !!p.closeToTray,
      launchAtLogin: !!p.launchAtLogin,
    };
  }
  if (section === 'timer') return { seconds: clamp(p.seconds, 0, 359999, current.seconds) };
  return {
    think: !!p.think,
    explain: !!p.explain,
    showExplain: !!p.showExplain,
    showWorking: !!p.showWorking,
    showThinking: !!p.showThinking,
    saveHistory: !!p.saveHistory,
  };
}

// ---------- steps after answering ----------
// Blocks that run in order after an answer: fill it in, click, find a button
// by its text, type, press keys, wait, scroll, copy, read aloud, put the mouse back.

const STEP_TYPES = ['fill', 'click', 'find', 'verify', 'type', 'keys', 'wait', 'scroll', 'copy', 'speak', 'mouse', 'repeat'];
const MAX_WAIT = 3600; // seconds: an hour
const cleanSeconds = (value, fallback, least) => Math.min(MAX_WAIT, Math.max(least, Math.round((Number(value) || fallback) * 10) / 10));
const cleanUnit = (unit) => (unit === 'min' ? 'min' : 'sec');
const KEYS_PATTERN =
  /^((Control|Alt|Shift|Super)\+){0,4}([A-Z0-9]|F([1-9]|1\d|2[0-4])|Space|Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|[`\-=[\];',./\\])$/;
const MAX_STEPS = 24;

const cleanPoint = (p) =>
  p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) ? { x: Math.round(Number(p.x)), y: Math.round(Number(p.y)) } : null;

/** What a Click block points at, learned when it was picked: { name, type }. */
function cleanTarget(target) {
  if (!target || typeof target.name !== 'string' || !target.name.trim()) return null;
  const clean = { name: text(target.name.trim(), 80), type: /^[a-z]{1,20}$/.test(target.type) ? target.type : 'text' };
  // How it looks (for things with no words): a small grey picture.
  const look = target.look;
  if (clean.type === 'look' && look && typeof look.data === 'string') {
    const [w, h, dx, dy] = [look.w, look.h, look.dx, look.dy].map((n) => Math.round(Number(n)));
    const fits = w >= 8 && w <= 128 && h >= 8 && h <= 128 && dx >= 0 && dx < w && dy >= 0 && dy < h;
    if (fits && /^[A-Za-z0-9+/=]+$/.test(look.data) && Buffer.from(look.data, 'base64').length === w * h) {
      clean.look = { w, h, dx, dy, data: look.data };
    }
  }
  return clean;
}

function cleanStep(step) {
  if (!step || !STEP_TYPES.includes(step.type)) return null;
  const id = typeof step.id === 'string' && /^[a-z0-9]{1,16}$/i.test(step.id) ? step.id : Math.random().toString(36).slice(2, 10);
  const { type } = step;
  switch (type) {
    case 'click':
      return {
        id,
        type,
        at: cleanPoint(step.at),
        target: cleanTarget(step.target),
        adaptive: step.adaptive !== false,
        button: ['left', 'right', 'double'].includes(step.button) ? step.button : 'left',
        settle: step.settle !== false,
      };
    case 'find':
      return { id, type, text: text(step.text, 80), where: step.where === 'screen' ? 'screen' : 'frame', settle: step.settle !== false };
    case 'type':
      return {
        id,
        type,
        source: step.source === 'custom' ? 'custom' : 'answer',
        text: text(step.text, 500),
        at: cleanPoint(step.at),
        target: cleanTarget(step.target),
      };
    case 'keys':
      return { id, type, keys: KEYS_PATTERN.test(step.keys) ? step.keys : 'Enter' };
    case 'wait':
      return { id, type, seconds: cleanSeconds(step.seconds, 1, 0.1), unit: cleanUnit(step.unit) };
    case 'verify':
      return {
        id,
        type,
        onWrong: ['retry', 'continue', 'stop'].includes(step.onWrong) ? step.onWrong : 'retry',
        tries: clamp(step.tries, 1, 3, 2),
      };
    case 'repeat':
      return {
        id,
        type,
        count: clamp(step.count, 1, 500, 10),
        seconds: step.seconds === 0 ? 0 : cleanSeconds(step.seconds, 0, 0),
        unit: cleanUnit(step.unit),
      };
    case 'scroll':
      return { id, type, direction: step.direction === 'up' ? 'up' : 'down', amount: clamp(step.amount, 1, 30, 3) };
    default:
      return { id, type };
  }
}

const MAX_PRESETS = 20;
const cleanList = (list) => list.map(cleanStep).filter(Boolean).slice(0, MAX_STEPS);

/** A saved set of blocks: { id, name, list }. */
function cleanPreset(preset) {
  if (!preset || typeof preset.name !== 'string' || !preset.name.trim() || !Array.isArray(preset.list)) return null;
  const list = cleanList(preset.list);
  if (!list.length) return null;
  const id = typeof preset.id === 'string' && /^[a-z0-9]{1,16}$/i.test(preset.id) ? preset.id : Math.random().toString(36).slice(2, 10);
  return { id, name: text(preset.name.trim(), 40), list };
}

function cleanSteps(value, current) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    on: typeof v.on === 'boolean' ? v.on : current.on,
    list: Array.isArray(v.list) ? cleanList(v.list) : current.list,
    presets: Array.isArray(v.presets) ? v.presets.map(cleanPreset).filter(Boolean).slice(0, MAX_PRESETS) : current.presets || [],
  };
}

function loadSettings() {
  const saved = readJson('settings.json', {});
  settings.steps = cleanSteps(saved.steps, DEFAULTS.steps);
  // "Fill in after answering" became a Fill in block.
  if (!saved.steps && saved.answers && saved.answers.autoFill) settings.steps = { on: true, list: [cleanStep({ type: 'fill' })], presets: [] };
  for (const key of ['models', 'keys', 'baseUrls']) {
    if (saved[key] && typeof saved[key] === 'object') settings[key] = saved[key];
  }
  if (saved.layout === LAYOUT) {
    for (const key of ['frame', 'widgetPos', 'timerPos']) if (saved[key]) settings[key] = saved[key];
  }
  if (typeof saved.frameVisible === 'boolean') settings.frameVisible = saved.frameVisible;
  if (PROVIDERS[saved.provider]) settings.provider = saved.provider;
  for (const section of SECTIONS) settings[section] = sanitize(section, saved[section], DEFAULTS[section]);
  history = readJson('history.json', []);
  if (!Array.isArray(history)) history = [];
}

function getKey(providerId) {
  const stored = settings.keys[providerId];
  if (!stored) return '';
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return '';
  }
}

function setKey(providerId, key) {
  if (!key) {
    delete settings.keys[providerId];
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new AppError("This computer can't encrypt the key, so it wasn't saved.");
    }
    // Encrypted with the Windows account (DPAPI); the key is never stored as plain text.
    settings.keys[providerId] = safeStorage.encryptString(key).toString('base64');
  }
  saveSettings();
}

const modelFor = (providerId) => settings.models[providerId] || PROVIDERS[providerId].defaultModel || '';
const baseUrlFor = (providerId) => settings.baseUrls[providerId] || '';
const hotkeyLabel = () => settings.behaviour.hotkey.replace('Control', 'Ctrl').replace('Super', 'Win').replace(/\+/g, ' + ');

function publicState() {
  return {
    provider: settings.provider,
    version: app.getVersion(),
    steps: settings.steps,
    suggestedDownloads: SUGGESTED_DOWNLOADS,
    hotkeyLabel: hotkeyLabel(),
    hotkeyWorks,
    frameVisible: settings.frameVisible,
    timerOpen: !!timerWin,
    prefs: Object.fromEntries(SECTIONS.map((section) => [section, settings[section]])),
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      needsKey: p.needsKey,
      hasKeyPage: !!p.keyUrl,
      model: modelFor(p.id),
      hasKey: !!settings.keys[p.id],
      baseUrl: baseUrlFor(p.id) || p.baseUrl,
      defaultBaseUrl: p.baseUrl,
    })),
  };
}

function broadcast() {
  const state = publicState();
  if (widget && !widget.isDestroyed()) widget.webContents.send('state', state);
  broadcastFrame();
  refreshTray();
  return state;
}

// ---------- captures on disk ----------

const captureFile = (id) => path.join(capturesDir(), `${String(id).replace(/[^a-z0-9]/gi, '')}.jpg`);

function saveCapture(id, jpeg) {
  fs.mkdirSync(capturesDir(), { recursive: true });
  fs.writeFileSync(captureFile(id), jpeg);
}

function readCapture(id) {
  try {
    return fs.readFileSync(captureFile(id));
  } catch {
    return null;
  }
}

function removeCapture(id) {
  fs.rmSync(captureFile(id), { force: true });
}

function sizeOf(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0);
  } catch {
    return 0;
  }
}

function storageInfo() {
  return {
    recents: history.length,
    recentsBytes: sizeOf(dataFile('history.json')) + sizeOf(capturesDir()),
    totalBytes: sizeOf(dataFile('history.json')) + sizeOf(capturesDir()) + sizeOf(dataFile('settings.json')),
  };
}

function clearRecents() {
  history = [];
  fs.rmSync(capturesDir(), { recursive: true, force: true });
  saveHistory();
}

/** Remove everything ScreenSage keeps on this PC and start again from defaults. */
function deleteAllData() {
  if (running) running.abort();
  conversation = null;
  session = null;
  history = [];
  fs.rmSync(capturesDir(), { recursive: true, force: true });
  for (const name of ['history.json', 'settings.json']) fs.rmSync(dataFile(name), { force: true });
  const frame = settings.frame;
  Object.assign(settings, structuredClone(DEFAULTS));
  settings.frame = frame;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false });
  hotkeyWorks = registerHotkey(settings.behaviour.hotkey);
  if (timerWin) timerWin.close();
  tell('reset');
  broadcast();
}

// ---------- geometry ----------

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const onSomeScreen = (rect, minimum) => screen.getAllDisplays().some((d) => overlapArea(d.workArea, rect) >= minimum);

function cleanRect(rect, loose) {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  if (!loose && (r.width < HOLE_MIN.width || r.height < HOLE_MIN.height)) return null;
  return r;
}

const validHole = (hole) => !!cleanRect(hole) && onSomeScreen(hole, 2500);

function defaultHole() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(520, area.width - 120);
  const height = Math.min(300, area.height - 160);
  return {
    x: Math.round(area.x + (area.width - width) / 2 - 100),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

// ---------- windows ----------

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

const ICON = path.join(__dirname, 'assets', 'icon.png');
const appIcon = (size) => nativeImage.createFromPath(ICON).resize({ width: size, height: size, quality: 'best' });

/** A frameless window of Windows 11 acrylic glass. */
function glassWindow(options) {
  const win = new BrowserWindow({
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // A tool window: no taskbar button, and Windows keeps it on every virtual desktop.
    skipTaskbar: true,
    show: false,
    icon: appIcon(256),
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    roundedCorners: true,
    webPreferences: webPreferences(),
    ...options,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error(`[${options.title}] ${details.message}`);
  });
  return win;
}

/** Keep the widget and timer above the frame overlays. */
function raiseFloating() {
  for (const win of [timerWin, widget]) if (win && !win.isDestroyed() && win.isVisible()) win.moveTop();
}

function cornerPosition(height) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - WIDGET.width - WIDGET.margin, y: area.y + WIDGET.margin, height };
}

/** Where the widget is, remembered by its top or bottom edge, whichever is nearer its screen's edge. */
function anchorOf(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const bottom = bounds.y + bounds.height / 2 > area.y + area.height / 2;
  return { x: bounds.x, y: bottom ? bounds.y + bounds.height : bounds.y, bottom };
}

function createWidget() {
  const height = 70;
  const saved = settings.widgetPos;
  let pos = saved && { x: saved.x, y: saved.bottom ? saved.y - height : saved.y };
  if (!pos || !onSomeScreen({ ...pos, width: WIDGET.width, height }, 4000)) pos = cornerPosition(height);
  widget = glassWindow({ x: pos.x, y: pos.y, width: WIDGET.width, height, title: 'ScreenSage' });
  widget.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widget.once('ready-to-show', () => {
    widget.showInactive();
    if (settings.frameVisible) showOverlays();
  });
  widget.on('moved', () => {
    settings.widgetPos = anchorOf(widget.getBounds());
    saveSettings();
  });
  widget.on('close', (event) => {
    if (quitting || !settings.behaviour.closeToTray) return;
    // Keep running in the tray; the shortcut still works.
    event.preventDefault();
    widget.hide();
    for (const win of overlays) win.hide();
  });
  widget.on('closed', () => {
    widget = null;
    app.quit();
  });
}

// The widget's height eases towards what its content needs, instead of jumping.
let heightTarget = null;
let heightTimer = null;

function setWidgetHeight(requested) {
  if (!widget || !Number.isFinite(requested)) return;
  const area = screen.getDisplayMatching(widget.getBounds()).workArea;
  heightTarget = Math.round(Math.min(WIDGET.maxHeight, area.height - WIDGET.margin * 2, Math.max(WIDGET.minHeight, requested)));
  if (heightTimer) return;
  heightTimer = setInterval(() => {
    if (!widget || widget.isDestroyed()) {
      clearInterval(heightTimer);
      heightTimer = null;
      return;
    }
    const b = widget.getBounds();
    const gap = heightTarget - b.height;
    const step = Math.abs(gap) <= 1 ? gap : Math.round(gap * 0.3) || Math.sign(gap);
    if (step === 0) {
      clearInterval(heightTimer);
      heightTimer = null;
      return;
    }
    const height = b.height + step;
    const display = screen.getDisplayMatching(b).workArea;
    // Grow away from the nearest screen edge, so a widget near the bottom grows upwards.
    const bottom = b.y + b.height / 2 > display.y + display.height / 2;
    let y = bottom ? b.y + b.height - height : b.y;
    y = Math.max(display.y, Math.min(y, display.y + display.height - height));
    widget.setBounds({ x: b.x, y, width: WIDGET.width, height });
  }, 10);
}

function resetPositions() {
  if (widget) {
    const { height } = widget.getBounds();
    const pos = cornerPosition(height);
    widget.setBounds({ x: pos.x, y: pos.y, width: WIDGET.width, height });
    settings.widgetPos = anchorOf(widget.getBounds());
  }
  settings.timerPos = null;
  if (timerWin) timerWin.setBounds({ ...timerHome(), width: TIMER.width, height: TIMER.height });
  settings.frame = defaultHole();
  saveSettings();
  broadcastFrame();
}

function showWidget() {
  if (!widget) return;
  if (!widget.isVisible()) {
    widget.showInactive();
    if (settings.frameVisible) showOverlays();
  }
  raiseFloating();
}

// ---------- timer window ----------

function timerHome() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(area.x + (area.width - TIMER.width) / 2), y: area.y + WIDGET.margin };
}

function toggleTimer() {
  if (timerWin) {
    timerWin.close();
    return;
  }
  const saved = settings.timerPos;
  const pos = saved && onSomeScreen({ ...saved, ...TIMER }, 2000) ? saved : timerHome();
  timerWin = glassWindow({ x: pos.x, y: pos.y, width: TIMER.width, height: TIMER.height, title: 'Timer' });
  timerWin.loadFile(path.join(__dirname, 'renderer', 'timer.html'));
  timerWin.once('ready-to-show', () => {
    timerWin.showInactive();
    raiseFloating();
  });
  timerWin.on('closed', () => {
    timerWin = null;
    stopWindowDrag();
    broadcast();
  });
  broadcast();
}

// Moving the timer follows the mouse, so the whole timer can be grabbed
// while clicks and scrolling on its time still work.
let windowDrag = null;

function startWindowDrag(win) {
  stopWindowDrag();
  const cursor = screen.getCursorScreenPoint();
  const start = win.getBounds();
  windowDrag = setInterval(() => {
    if (win.isDestroyed()) return stopWindowDrag();
    const now = screen.getCursorScreenPoint();
    win.setBounds({ ...start, x: start.x + now.x - cursor.x, y: start.y + now.y - cursor.y });
  }, 8);
}

function stopWindowDrag() {
  if (!windowDrag) return;
  clearInterval(windowDrag);
  windowDrag = null;
  if (timerWin) {
    const { x, y } = timerWin.getBounds();
    settings.timerPos = { x, y };
    saveSettings();
  }
}

// ---------- image viewer ----------

function openImage(id) {
  const jpeg = session && session.id === id && session.full ? session.full : readCapture(id);
  const entry = history.find((item) => item.id === id);
  const dataUrl = jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : entry && entry.thumb;
  if (!dataUrl) return;
  const image = nativeImage.createFromDataURL(dataUrl);
  const size = image.getSize();
  const display = screen.getDisplayMatching(widget ? widget.getBounds() : screen.getPrimaryDisplay().bounds);
  const area = display.workArea;
  const natural = { width: size.width / display.scaleFactor, height: size.height / display.scaleFactor };
  const fit = Math.min(1, (area.width * 0.78) / natural.width, (area.height * 0.78) / natural.height);
  const pad = 10;
  const width = Math.max(220, Math.round(natural.width * fit) + pad * 2);
  const height = Math.max(140, Math.round(natural.height * fit) + pad * 2);
  if (viewer) viewer.destroy();
  viewer = glassWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    title: 'Capture',
  });
  viewer.loadFile(path.join(__dirname, 'renderer', 'viewer.html'));
  viewer.webContents.once('did-finish-load', () => {
    if (!viewer) return;
    viewer.webContents.send('viewer:image', dataUrl);
    viewer.show();
    viewer.focus();
  });
  // Clicking somewhere else closes it, once it has been in front.
  viewer.once('focus', () => viewer.on('blur', () => viewer && !viewer.isDestroyed() && viewer.close()));
  viewer.on('closed', () => {
    viewer = null;
  });
}

// ---------- frame overlays ----------

function overlayState(win) {
  return {
    origin: { x: win.area.x, y: win.area.y },
    size: { width: win.area.width, height: win.area.height },
    hole: settings.frame,
    visible: settings.frameVisible || !!picking,
    picking: !!picking,
    shade: settings.frameStyle.shade,
    shadeStrength: settings.frameStyle.shadeStrength,
    selecting,
    selection,
  };
}

function broadcastFrame(except) {
  for (const win of overlays) {
    if (!win.isDestroyed() && win !== except) win.webContents.send('overlay', overlayState(win));
  }
}

function showOverlays() {
  for (const win of overlays) if (!win.isVisible()) win.showInactive();
  raiseFloating();
}

function buildOverlays() {
  for (const win of [...overlays]) if (!win.isDestroyed()) win.destroy();
  overlays.clear();
  for (const display of screen.getAllDisplays()) {
    const area = display.workArea;
    const win = new BrowserWindow({
      ...area,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      roundedCorners: false,
      show: false,
      title: 'Frame',
      webPreferences: webPreferences(),
    });
    win.area = area;
    win.setAlwaysOnTop(true, 'screen-saver');
    // Clicks pass straight through to the apps underneath, except on the
    // frame's handles and toolbar (frame.js switches this while hovering them).
    win.setIgnoreMouseEvents(true, { forward: true });
    // Whenever it takes clicks, a fully solid overlay would count as a window covering the whole
    // screen, and browsers under it would hide their page (and its controls). A hair of
    // see-through keeps them showing.
    win.setOpacity(OVERLAY_OPACITY);
    win.loadFile(path.join(__dirname, 'renderer', 'frame.html'));
    win.webContents.once('did-finish-load', () => {
      win.setBounds(area); // Windows can size it wrongly on screens with different scaling
      win.webContents.send('overlay', overlayState(win));
      if (settings.frameVisible && widget && widget.isVisible()) showOverlays();
    });
    win.on('closed', () => overlays.delete(win));
    overlays.add(win);
  }
}

let hideTimer = null;

function setFrameVisible(visible) {
  if (!visible && selecting) endSelect(null);
  settings.frameVisible = visible;
  saveSettings();
  clearTimeout(hideTimer);
  if (visible) {
    showOverlays();
    broadcast();
  } else {
    broadcast(); // the overlays fade out first
    hideTimer = setTimeout(() => {
      if (!settings.frameVisible) for (const win of overlays) win.hide();
    }, 280);
  }
}

function setShade(on) {
  settings.frameStyle = sanitize('frameStyle', { shade: on }, settings.frameStyle);
  saveSettings();
  if (!settings.frameVisible) setFrameVisible(true);
  else broadcast();
}

function startSelect() {
  if (selecting) return;
  if (!settings.frameVisible) setFrameVisible(true);
  selecting = true;
  selection = null;
  for (const win of overlays) win.setIgnoreMouseEvents(false);
  try {
    globalShortcut.register('Escape', () => endSelect(null));
  } catch {
    // Esc is taken; a right-click still cancels.
  }
  broadcastFrame();
}

function endSelect(rect) {
  if (!selecting) return;
  selecting = false;
  selection = null;
  globalShortcut.unregister('Escape');
  const hole = cleanRect(rect);
  if (hole && validHole(hole)) {
    settings.frame = hole;
    saveSettings();
  }
  for (const win of overlays) win.setIgnoreMouseEvents(true, { forward: true });
  broadcastFrame();
  raiseFloating();
}

let rebuildTimer = null;
function screensChanged() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (!validHole(settings.frame)) settings.frame = defaultHole();
    buildOverlays();
  }, 400);
}

// ---------- screen capture ----------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Take a picture of one rectangle of the screen. Returns a NativeImage. */
async function captureRect(rect, { full = false, shrink = 1 } = {}) {
  const display = screen.getDisplayMatching(rect);
  const scale = (display.scaleFactor || 1) / shrink;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new AppError("Couldn't capture the screen. Check that screen capture is allowed.");
  }
  const shot = source.thumbnail;
  const size = shot.getSize();
  // The picture is in real pixels; the rectangle is in scaled screen units.
  const kx = size.width / display.bounds.width;
  const ky = size.height / display.bounds.height;
  const x = Math.max(0, Math.round((rect.x - display.bounds.x) * kx));
  const y = Math.max(0, Math.round((rect.y - display.bounds.y) * ky));
  const width = Math.min(size.width - x, Math.round(rect.width * kx));
  const height = Math.min(size.height - y, Math.round(rect.height * ky));
  if (width < 8 || height < 8) throw new AppError('The frame is off the screen. Move it back and try again.');
  let image = shot.crop({ x, y, width, height });
  if (!full && width > MAX_IMAGE_WIDTH) image = image.resize({ width: MAX_IMAGE_WIDTH, quality: 'best' });
  return image;
}

/** Capture the frame. Any of our windows in the way step aside for a moment. */
async function captureFrame() {
  const inTheWay = [widget, timerWin].filter(
    (win) => win && !win.isDestroyed() && win.isVisible() && overlapArea(win.getBounds(), settings.frame) > 0,
  );
  for (const win of inTheWay) win.setOpacity(0);
  if (inTheWay.length) await wait(120);
  try {
    return await captureRect(settings.frame);
  } finally {
    for (const win of inTheWay) win.setOpacity(1);
  }
}

// ---------- answering ----------

function tell(channel, payload) {
  if (widget && !widget.isDestroyed()) widget.webContents.send(channel, payload);
}

function recordHistory() {
  if (!settings.answers.saveHistory || !session) return;
  const messages = conversation
    .filter((m) => m.role !== 'system')
    .slice(1) // the first message is the capture itself
    .map((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.content === RETRY ? '' : m.content, retry: m.content === RETRY }
        : { role: 'assistant', content: m.content, ...(m.thinking ? { thinking: m.thinking } : {}) },
    );
  if (!session.saved) {
    saveCapture(session.id, session.full);
    session.saved = true;
  }
  const entry = { id: session.id, time: session.time, thumb: session.thumb, messages };
  history = [entry, ...history.filter((item) => item.id !== entry.id)];
  for (const old of history.slice(MAX_HISTORY)) removeCapture(old.id);
  history = history.slice(0, MAX_HISTORY);
  saveHistory();
}

// ---------- thinking that goes in circles ----------
// A model that keeps doubling back ("wait… actually… let me re-check…") is
// stopped and starts over with a note to be decisive. The third try runs to the end.

const RUNAWAY = { thinking: 14000, reply: 9000 };
const SECOND_GUESS =
  /\b(?:wait|hmm+|actually|hold on|on second thought|let me (?:re-?check|re-?verify|verify|double[- ]check|reconsider|re-?read|re-?do|recompute|recalculate|re-?evaluate|start over|try again|go back))\b/gi;

function goingInCircles(text, limit) {
  if (text.length > limit) return true;
  if (text.length < 2500) return false;
  const doubts = (text.match(SECOND_GUESS) || []).length;
  if (doubts >= 12 && doubts / (text.length / 1000) >= 2.5) return true;
  const seen = new Map();
  for (const sentence of text.toLowerCase().split(/(?<=[.!?\n])\s+/)) {
    const key = sentence.replace(/\s+/g, ' ').trim();
    if (key.length < 24) continue;
    const count = (seen.get(key) || 0) + 1;
    if (count >= 3) return true; // the same sentence, over and over
    seen.set(key, count);
  }
  return false;
}

const calmed = (messages) =>
  messages.map((m) => (m.role === 'system' ? { ...m, content: `${m.content}\n\n${CALM}` } : m));

const normalAnswer = (a) =>
  toPlain(a)
    .toLowerCase()
    .replace(/^\(?[a-h][.):]\s+/, '') // "B. Paris" and "Paris" are the same answer
    .replace(/[\s.,;:!*"'`]/g, '');
const sameAnswer = (a, b) => normalAnswer(a) === normalAnswer(b);

/**
 * Write the next reply into the conversation. build({ repeats }) gives the
 * messages to send; rejects(answer) is true for an answer already marked wrong.
 */
async function writeAnswer({ build = () => conversation, think = settings.answers.think, temperature, rejects } = {}) {
  const controller = new AbortController();
  running = controller;
  const providerId = settings.provider;
  let resets = 0;
  let repeats = 0;
  try {
    for (;;) {
      const turn = new AbortController();
      const stopTurn = () => turn.abort();
      controller.signal.addEventListener('abort', stopTurn);
      const watching = resets < 2;
      let thinking = '';
      let text = '';
      let held = ''; // text not shown yet because this try is being stopped
      let circling = false;
      const marks = { thinking: 0, text: 0 };
      const watch = (all, kind, limit) => {
        if (!watching || circling || all.length - marks[kind] < 600) return;
        marks[kind] = all.length;
        if (goingInCircles(all, limit)) {
          circling = true;
          turn.abort();
        }
      };
      let messages = build({ repeats });
      if (resets) messages = calmed(messages);
      try {
        let reply = await chat(providerId, {
          model: modelFor(providerId),
          apiKey: getKey(providerId),
          baseUrl: baseUrlFor(providerId),
          messages,
          think: resets >= 2 ? false : think,
          temperature: repeats ? Math.min(1, (temperature ?? 0.2) + 0.3 * repeats) : temperature,
          signal: turn.signal,
          onChunk: (piece) => {
            text += piece;
            if (circling) held += piece;
            else if (running === controller) tell('answer:chunk', piece);
            watch(text, 'text', RUNAWAY.reply);
          },
          onThinking: (piece) => {
            thinking += piece;
            if (running === controller && !circling) tell('answer:thinking', piece);
            watch(thinking, 'thinking', RUNAWAY.thinking);
          },
        });
        // A provider that sends everything at once finishes before it can be stopped: keep it.
        if (held && running === controller) tell('answer:chunk', held);
        if (rejects) {
          // Its own list of best answers gives one that isn't marked wrong.
          const fresh = candidatesOf(reply).find((c) => !rejects(c));
          reply = reply.replace(/<candidates>[\s\S]*?<\/candidates>\s*/i, '');
          if (rejects(answerOf(reply)) && fresh) {
            reply = withAnswer(reply, fresh);
            tell('answer:replace', reply);
          }
          if (rejects(answerOf(reply))) {
            if (repeats < 3) {
              repeats += 1;
              tell('answer:rethink', 'repeat');
              continue;
            }
            tell('toast', 'It still came back with the same answer.');
          }
        }
        conversation.push({ role: 'assistant', content: reply, ...(thinking ? { thinking } : {}) });
        recordHistory();
        if (running === controller) tell('answer:done');
        return reply;
      } catch (error) {
        if (circling && !controller.signal.aborted) {
          resets += 1;
          tell('answer:rethink', 'circles');
          continue;
        }
        throw error;
      } finally {
        controller.signal.removeEventListener('abort', stopTurn);
      }
    }
  } catch (error) {
    if (running === controller) {
      if (error.code === 'aborted') tell('answer:done');
      else tell('answer:error', error instanceof AppError ? error.message : `Something went wrong: ${error.message}`);
    }
    throw error;
  } finally {
    if (running === controller) running = null;
  }
}

/** Runs only when the user presses Answer (or the shortcut). Nothing is read before that. */
async function ask({ chained = false } = {}) {
  if (!widget || running || filling || picking) return;
  if (!chained) chain = null; // answering by hand ends a Keep going run
  showWidget();
  if (selecting) endSelect(null);
  if (!settings.frameVisible) {
    setFrameVisible(true);
    return;
  }
  let image;
  try {
    image = await captureFrame();
  } catch (error) {
    tell('answer:start', null);
    tell('answer:error', error.message);
    return;
  }
  const size = image.getSize();
  const full = image.toJPEG(88);
  const thumb = image.resize({ width: Math.min(240, size.width) }).toJPEG(75).toString('base64');
  session = { id: Date.now().toString(36), time: Date.now(), thumb: `data:image/jpeg;base64,${thumb}`, full, saved: false };
  conversation = [
    { role: 'system', content: systemPrompt(settings.answers.explain) },
    { role: 'user', content: QUESTION, images: [full.toString('base64')] },
  ];
  tell('answer:start', { id: session.id, time: session.time, thumb: session.thumb });
  // In a Keep going run nobody pressed Answer, so Esc stops this one too.
  if (chained) {
    try {
      escapeHeld = globalShortcut.register('Escape', () => {
        chain = null;
        if (running) running.abort();
      });
    } catch {
      escapeHeld = false;
    }
  }
  const reply = await writeAnswer()
    .catch(() => null)
    .finally(() => chained && releaseEscape());
  if (!reply) chain = null;
  else if (settings.steps.on || chained) runSteps({ chained });
}

async function sendAfter(message, channel, payload, options) {
  if (!conversation || running) return null;
  conversation.push({ role: 'user', content: message });
  tell(channel, payload);
  return writeAnswer(options).catch(() => {
    // Drop the message that got no answer so the conversation stays valid.
    if (conversation[conversation.length - 1].role === 'user') conversation.pop();
    return null;
  });
}

const followUp = (input) => {
  const question = text(input, 2000).trim();
  if (question) sendAfter(question, 'answer:followup', question);
};

/**
 * Wrong answer: ask the same question again from scratch, without the wrong
 * reasoning in view, listing every answer that was wrong. Fresh thinking, a
 * little more variety, and a reply that only repeats a wrong answer is asked again.
 */
function rethink({ said = [] } = {}) {
  if (!conversation || running || conversation[conversation.length - 1].role !== 'assistant') return Promise.resolve(null);
  let question = conversation.length - 1;
  while (question > 0 && !(conversation[question].role === 'user' && conversation[question].content !== RETRY)) question -= 1;
  const rejected = [];
  for (const m of conversation.slice(question + 1)) {
    const answer = m.role === 'assistant' ? answerOf(m.content) : '';
    if (answer && !rejected.some((r) => sameAnswer(r, answer))) rejected.push(answer);
  }
  // What the quiz itself said ("Not quite, the answer is 8") is the best clue there is.
  const quizSaid = said.length
    ? `\n\nWhen the answer was checked, the quiz said:\n${said.map((line) => `- ${text(line, 300)}`).join('\n')}`
    : '';
  const base = conversation.slice(0, question + 1);
  const build = ({ repeats }) =>
    base.map((m, i) => (i === question ? { ...m, content: `${m.content}\n\n${retryNote(rejected, repeats)}${quizSaid}` } : m));
  return sendAfter(RETRY, 'answer:retry', undefined, {
    build,
    think: true,
    temperature: 0.6,
    rejects: (answer) => rejected.some((r) => sameAnswer(r, answer)),
  });
}

/** The quiz showed the right answer: take it as the new answer, no model needed. */
function takeAnswer(value) {
  if (!conversation || running || conversation[conversation.length - 1].role !== 'assistant') return null;
  conversation.push({ role: 'user', content: RETRY });
  tell('answer:retry');
  const reply = `<answer>\n${value}\n</answer>\n<working>\nThe quiz showed the correct answer: ${value}\n</working>`;
  tell('answer:chunk', reply);
  conversation.push({ role: 'assistant', content: reply });
  recordHistory();
  tell('answer:done');
  return reply;
}

const retry = () =>
  rethink().then((reply) => {
    if (reply && settings.steps.on) runSteps();
  });

// ---------- downloading models ----------

let downloading = null; // { providerId, controller }

async function startDownload(providerId, model) {
  if (downloading) return { ok: false, error: 'A download is already running.' };
  const controller = new AbortController();
  downloading = { providerId, controller };
  let last = 0;
  try {
    await downloadModel(providerId, {
      baseUrl: baseUrlFor(providerId),
      model,
      signal: controller.signal,
      onProgress: (progress) => {
        const now = Date.now();
        if (now - last < 150) return; // keep the bar smooth without flooding the window
        last = now;
        tell('download:progress', progress);
      },
    });
    settings.models[providerId] = String(model).trim();
    saveSettings();
    return { ok: true, state: publicState() };
  } catch (error) {
    return { ok: false, stopped: error.code === 'aborted', error: error.message };
  } finally {
    downloading = null;
  }
}

// ---------- updates ----------
// Only when the user presses "Check for updates": asks GitHub for the latest
// release, and on "Update" downloads its installer, checks it and runs it.

const RELEASES = 'https://api.github.com/repos/vptr-dev/screensage/releases/latest';
let update = null; // the newer release found by the last check
let updating = false;

const versionParts = (v) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function checkUpdate() {
  let release;
  try {
    const res = await fetch(RELEASES, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ScreenSage' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(String(res.status));
    release = await res.json();
  } catch {
    return { ok: false, error: "Couldn't check for updates. Check your internet connection." };
  }
  const asset = (release.assets || []).find((a) => /\.exe$/i.test(a.name));
  if (!asset || !isNewer(release.tag_name, app.getVersion())) {
    update = null;
    return { ok: true, available: false };
  }
  update = {
    version: String(release.tag_name).replace(/^v/i, ''),
    url: asset.browser_download_url,
    size: asset.size,
    sha256: /^sha256:[0-9a-f]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7).toLowerCase() : null,
  };
  return { ok: true, available: true, version: update.version, size: update.size };
}

async function installUpdate() {
  if (!update || updating) return { ok: false, error: 'Check for updates first.' };
  updating = true;
  const file = path.join(app.getPath('temp'), `ScreenSage Setup ${update.version}.exe`);
  try {
    const res = await fetch(update.url, { headers: { 'user-agent': 'ScreenSage' } });
    if (!res.ok || !res.body) throw new Error(String(res.status));
    const total = Number(res.headers.get('content-length')) || update.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let done = 0;
    let last = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      if (Date.now() - last > 150) {
        last = Date.now();
        tell('update:progress', { done, total });
      }
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    if (update.sha256 && hash.digest('hex') !== update.sha256) {
      fs.rmSync(file, { force: true });
      throw new Error('checksum');
    }
  } catch (error) {
    updating = false;
    return {
      ok: false,
      error: error.message === 'checksum' ? "The download didn't check out. Try again." : "Couldn't download the update. Try again.",
    };
  }
  tell('update:progress', { installing: true });
  // The installer replaces this copy (keeping all data), then opens the new one.
  spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 400);
  return { ok: true };
}

// ---------- fill in ----------
// Puts the latest answer into the question inside the frame: the model looks at
// a fresh capture and says where to click, type or drag, a few rounds at most.

/** The <answer> part of a reply (or its first paragraph, if the model ignored the format). */
function answerOf(content) {
  const match = String(content || '').match(/<answer>\s*([\s\S]*?)\s*(?:<\/answer>|<explain>|<working>|$)/i);
  return (match ? match[1] : String(content || '').split(/\n\s*\n/)[0]).trim();
}

function latestAnswer() {
  const last = conversation && [...conversation].reverse().find((m) => m.role === 'assistant');
  return last ? answerOf(last.content) : '';
}

const unquote = (s) => s.trim().replace(/^["'“‘<](.*)["'”’>]$/, '$1');

/** Read the model's commands, one per line. Anything it can't follow is skipped. */
function readCommands(reply, count) {
  const actions = [];
  let look = false;
  const id = (n) => {
    const i = Number(n) - 1;
    return i >= 0 && i < count ? i : null;
  };
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/[`*]/g, '').replace(/^\s*(?:[-•>]|\d+[.)])\s+/, '').trim();
    let m;
    if (/^look\b/i.test(line)) look = true;
    // "click 9 option "3/4"" still means click 9.
    else if (count && (m = line.match(/^click\s+#?(\d+)(?:\s|$)/i)) && id(m[1]) !== null) actions.push({ type: 'click', target: id(m[1]) });
    else if (count && (m = line.match(/^type\s+#?(\d+)\s+(.+)$/i)) && id(m[1]) !== null) {
      // A model that copies the command's description back has nothing to type.
      if (!/\btext box\b|<text>/i.test(m[2])) actions.push({ type: 'type', target: id(m[1]), text: unquote(m[2]) });
    }
    else if (count && (m = line.match(/^choose\s+#?(\d+)\s+(.+)$/i)) && id(m[1]) !== null) actions.push({ type: 'choose', target: id(m[1]), text: unquote(m[2]) });
    else if (count && (m = line.match(/^drag\s+#?(\d+)\s+(?:on(?:to)?\s+|to\s+)?#?(\d+)\s*$/i)) && id(m[1]) !== null && id(m[2]) !== null) {
      actions.push({ type: 'drag', from: id(m[1]), to: id(m[2]) });
    } else if (!count && (m = line.match(/^click\s+(\d+)[\s,]+(\d+)\s*$/i))) actions.push({ type: 'click', at: { x: +m[1], y: +m[2] } });
    else if (!count && (m = line.match(/^type\s+(.+)$/i))) actions.push({ type: 'type', text: unquote(m[1]) });
    else if (!count && (m = line.match(/^drag\s+(\d+)[\s,]+(\d+)[\s,]+(?:to\s+)?(\d+)[\s,]+(\d+)\s*$/i))) {
      actions.push({ type: 'drag', fromAt: { x: +m[1], y: +m[2] }, toAt: { x: +m[3], y: +m[4] } });
    } else if ((m = line.match(/^key\s+(enter|tab|down|up)\b/i))) actions.push({ type: 'key', key: m[1].toLowerCase() });
  }
  return { actions: actions.slice(0, 16), look };
}

/** A point on the 0–1000 grid of the capture, as a real screen pixel. */
function gridToScreen(rect, point) {
  const gx = Math.min(1000, Math.max(0, Number(point && point.x) || 0));
  const gy = Math.min(1000, Math.max(0, Number(point && point.y) || 0));
  return screen.dipToScreenPoint({ x: rect.x + (gx / 1000) * rect.width, y: rect.y + (gy / 1000) * rect.height });
}

async function clickAt(p) {
  await input.move(p.x, p.y);
  await wait(120);
  await input.down();
  await input.up();
}

/** Run one command. Elements carry real screen pixels; grid points are mapped from the frame. */
async function perform(action, rect, elements, signal) {
  const check = () => {
    if (signal.aborted) throw Object.assign(new Error('stopped'), { code: 'aborted' });
  };
  check();
  const target = action.target != null ? elements[action.target] : null;
  if (action.type === 'click') {
    if (target && (target.type === 'button' || target.type === 'hyperlink') && SUBMIT_WORDS.test(target.name)) return;
    await clickAt(target || gridToScreen(rect, action.at));
  } else if (action.type === 'type') {
    if (target) {
      await clickAt(target);
      await wait(150);
      await input.key('selectall');
      await wait(80); // let Ctrl come up first, or the first letter becomes a shortcut
    }
    await input.type(action.text.slice(0, 2000));
  } else if (action.type === 'choose') {
    // Opening the dropdown and typing the entry picks it, in browsers and most apps.
    await clickAt(target);
    await wait(350);
    await input.type(action.text.slice(0, 200));
    await wait(200);
    await input.key('enter');
  } else if (action.type === 'key') {
    await input.key(action.key);
  } else if (action.type === 'drag') {
    const from = action.from != null ? elements[action.from] : gridToScreen(rect, action.fromAt);
    const to = action.to != null ? elements[action.to] : gridToScreen(rect, action.toAt);
    await input.move(from.x, from.y);
    await wait(120);
    await input.down();
    // Pages only notice a drag if the pointer moves in between.
    for (let step = 1; step <= 16; step++) {
      check();
      await input.move(from.x + ((to.x - from.x) * step) / 16, from.y + ((to.y - from.y) * step) / 16);
      await wait(18);
    }
    await wait(80);
    await input.up();
  }
  await wait(300);
}

/** The controls inside the frame. Browsers switch their accessibility on at the first ask, so ask twice. */
async function frameElements(rect) {
  const pixels = screen.dipToScreenRect(null, rect);
  let list = await input.elements(pixels, process.pid);
  if (list.length < 2) {
    // Browsers build their page's controls for Windows once something walks through them.
    await input.wake({ x: pixels.x + pixels.width / 2, y: pixels.y + pixels.height / 2 }, process.pid).catch(() => {});
    await wait(400);
    list = await input.elements(pixels, process.pid);
  }
  // Labels that only repeat a control's name add nothing.
  const named = new Set(list.filter((e) => e.type !== 'text').map((e) => e.name));
  return list.filter((e) => e.type !== 'text' || !named.has(e.name)).slice(0, 80);
}

const stopped = () => Object.assign(new Error('stopped'), { code: 'aborted' });

/** Wait, but stop at once when the run is stopped. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(stopped());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(stopped());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Our own windows step aside (see-through and click-through) while fn runs. */
async function aside(area, fn) {
  const ours = [widget, timerWin, viewer].filter(
    (win) => win && !win.isDestroyed() && win.isVisible() && (!area || overlapArea(win.getBounds(), area) > 0),
  );
  for (const win of ours) {
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
  }
  try {
    return await fn();
  } finally {
    for (const win of ours) {
      if (win.isDestroyed()) continue;
      win.setIgnoreMouseEvents(false);
      win.setOpacity(1);
    }
  }
}

const around = (p) => ({ x: p.x - 4, y: p.y - 4, width: 8, height: 8 });

/** Fill in: the model looks at the frame (and the controls in it) and enters the answer. */
async function fillCore(answer, controller) {
  const providerId = settings.provider;
  const done = [];
  for (let roundNo = 0; roundNo < FILL_ROUNDS && !controller.signal.aborted; roundNo++) {
    const rect = { ...settings.frame };
    const [image, elements] = await Promise.all([captureFrame(), frameElements(rect).catch(() => [])]);
    const note = done.length
      ? `Already done: ${done.join('; ')}. This is the screen now. Reply done if the answer is in.`
      : 'This is the screen now.';
    const reply = await chat(providerId, {
      model: modelFor(providerId),
      apiKey: getKey(providerId),
      baseUrl: baseUrlFor(providerId),
      messages: [
        { role: 'system', content: fillPrompt(answer, elements) },
        { role: 'user', content: note, images: [image.toJPEG(88).toString('base64')] },
      ],
      signal: controller.signal,
    });
    if (process.env.SAGE_DEBUG) console.log(`fill round ${roundNo + 1}: ${elements.length} controls\n${reply}`);
    const plan = readCommands(reply, elements.length);
    await aside(rect, async () => {
      for (const action of plan.actions) {
        await perform(action, rect, elements, controller.signal);
        const target = action.target != null ? ` ${action.target + 1}` : '';
        done.push(`${action.type}${target}${action.text ? ` "${action.text}"` : ''}`);
      }
    });
    if (!plan.look || !plan.actions.length) break;
    await pause(400, controller.signal); // let the page react before looking again
  }
  return done.length;
}

// ---------- running mouse and keyboard work ----------
// Fill in and the steps share this: one at a time, Esc or Stop ends it, and
// the frame lets every click through while it runs.

let escapeHeld = false;
function holdEscape(controller) {
  try {
    escapeHeld = globalShortcut.register('Escape', () => controller.abort());
  } catch {
    escapeHeld = false; // Esc is taken; the Stop button still works.
  }
}
function releaseEscape() {
  if (escapeHeld) globalShortcut.unregister('Escape');
  escapeHeld = false;
}

async function automate(kind, job) {
  if (filling || running || picking) return;
  const controller = new AbortController();
  filling = controller;
  input.warmUp();
  tell('auto:state', { on: true, kind });
  holdEscape(controller);
  for (const win of overlays) win.setIgnoreMouseEvents(true);
  let error = null;
  let result = null;
  try {
    result = await job(controller, (index) => tell('auto:state', { on: true, kind, index }));
  } catch (caught) {
    if (caught.code !== 'aborted' && !controller.signal.aborted) {
      error = caught instanceof AppError ? caught.message : `Something went wrong: ${caught.message}`;
    }
  } finally {
    releaseEscape();
    for (const win of overlays) if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
    filling = null;
    tell('auto:state', { on: false, kind, error, result, stopped: controller.signal.aborted });
    raiseFloating();
  }
}

function fillIn() {
  const answer = latestAnswer();
  if (!answer || !settings.frameVisible) return;
  automate('fill', (controller) => fillCore(answer, controller));
}

// ---------- the steps ----------

const simple = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const CLICKABLE = new Set(['button', 'hyperlink', 'menuitem', 'tabitem', 'listitem', 'radiobutton', 'checkbox', 'splitbutton', 'treeitem']);
const TYPING = new Set(['edit', 'combobox', 'document', 'spinner']);
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
  text: 'text',
};

/** A learned target as words: button "Next". Ones learned by looking are already words. */
const describe = (target) => (target.type === 'look' ? target.name : `${KIND_WORDS[target.type] || 'control'} "${target.name}"`);

/** Edits between two strings. */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** How well a name fits the wanted one: 4 the same, 2 starts or ends with it, 1 mentions it or is nearly it. */
function fitOf(have, want) {
  if (!have || !want) return 0;
  if (have === want) return 4;
  if (have.startsWith(want) || have.endsWith(want)) return 2;
  if (have.includes(want)) return 1;
  // Read off the screen, a letter or two can come out wrong.
  return Math.abs(have.length - want.length) <= 2 && distance(have, want) <= Math.floor(want.length / 5) ? 1 : 0;
}

/** The control that fits best: the name first, then the kind, then the one nearest where it was. */
function bestMatch(found, { name, type, near }) {
  const want = simple(name);
  let best = null;
  let bestScore = -Infinity;
  for (const f of found) {
    const have = simple(f.name);
    const fit = fitOf(have, want);
    if (!fit) continue;
    const wordy = Math.min(6, Math.max(0, have.length - want.length) / Math.max(want.length, 4)); // a sentence that mentions it
    const kind = type && f.type === type ? 6 : CLICKABLE.has(f.type) ? 3 : 0;
    const far = near ? Math.min(5, Math.hypot(f.x - near.x, f.y - near.y) / 400) : 0;
    const score = fit * 10 - wordy + kind - far;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

/** A rectangle (screen units) cut to fit on a display. */
function onDisplay(rect, display = screen.getDisplayMatching(rect)) {
  const b = display.bounds;
  const x = Math.max(b.x, rect.x);
  const y = Math.max(b.y, rect.y);
  return {
    x,
    y,
    width: Math.max(1, Math.min(b.x + b.width, rect.x + rect.width) - x),
    height: Math.max(1, Math.min(b.y + b.height, rect.y + rect.height) - y),
  };
}

/** Where to look around a spot: the frame and the space around the spot, on the spot's display. */
function areaAround(point) {
  const frame = settings.frame;
  const left = Math.min(frame.x, point.x - 240);
  const top = Math.min(frame.y, point.y - 120);
  const right = Math.max(frame.x + frame.width, point.x + 240);
  const bottom = Math.max(frame.y + frame.height, point.y + 120);
  return onDisplay({ x: left, y: top, width: right - left, height: bottom - top }, screen.getDisplayNearestPoint(point));
}

/** A picture of an area without our windows or the frame's shade in it. */
async function cleanCapture(areaDip, options = {}) {
  const overlayWins = [...overlays].filter((win) => !win.isDestroyed());
  for (const win of overlayWins) win.setOpacity(0);
  try {
    return await aside(null, async () => {
      await wait(120);
      return captureRect(areaDip, { full: true, ...options });
    });
  } finally {
    for (const win of overlayWins) if (!win.isDestroyed()) win.setOpacity(OVERLAY_OPACITY);
  }
}

const boxOf = (words) => ({
  left: Math.min(...words.map((w) => w.x)),
  top: Math.min(...words.map((w) => w.y)),
  right: Math.max(...words.map((w) => w.x + w.w)),
  bottom: Math.max(...words.map((w) => w.y + w.h)),
});

/** Words grouped into phrases: one line, split where there is a wide gap (two buttons side by side). */
function phrasesOf(words) {
  const lines = new Map();
  for (const w of words) {
    if (!lines.has(w.line)) lines.set(w.line, []);
    lines.get(w.line).push(w);
  }
  const phrases = [];
  for (const line of lines.values()) {
    line.sort((a, b) => a.x - b.x);
    let run = [];
    for (const w of line) {
      const last = run[run.length - 1];
      if (last && w.x - (last.x + last.w) > 1.2 * Math.max(last.h, w.h)) {
        phrases.push(run);
        run = [];
      }
      run.push(w);
    }
    if (run.length) phrases.push(run);
  }
  return phrases.map((words) => ({ words, text: words.map((w) => w.t).join(' '), box: boxOf(words) }));
}

/**
 * The words Windows can read in an area, as phrases placed in real screen pixels. The reader can
 * miss words at one size and read them at another, so it reads at a few sizes, adding up what it
 * finds, until `enough` is happy.
 */
async function readScreen(areaDip, enough = (seen) => seen.phrases.length > 0, onShot = null) {
  const shot = await cleanCapture(areaDip);
  if (onShot) onShot(shot);
  const size = shot.getSize();
  const real = screen.dipToScreenRect(null, areaDip);
  // Small print reads better bigger; the reader takes about 2600 pixels a side at most.
  const most = 2560 / Math.max(size.width, size.height);
  const scales = [...new Set([Math.min(2, most), Math.min(1, most), Math.min(1.5, most)].map((k) => Math.round(k * 100) / 100))];
  const file = path.join(app.getPath('temp'), `screensage-read-${process.pid}.png`);
  const seen = { phrases: [] };
  for (const k of scales) {
    const image = k === 1 ? shot : shot.resize({ width: Math.round(size.width * k), height: Math.round(size.height * k), quality: 'best' });
    fs.writeFileSync(file, image.toPNG());
    let words;
    try {
      words = await input.readWords(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
    const pic = image.getSize();
    const [kx, ky] = [real.width / pic.width, real.height / pic.height];
    const placed = words.map((w) => ({ ...w, x: real.x + w.x * kx, y: real.y + w.y * ky, w: w.w * kx, h: w.h * ky }));
    seen.phrases.push(...phrasesOf(placed));
    if (enough(seen)) break;
  }
  return seen;
}

/** Phrases on screen with the words in them, as places to click (real pixels). */
function textHits(seen, name) {
  const want = simple(name);
  const hits = [];
  if (!want) return hits;
  for (const phrase of seen.phrases) {
    const { words } = phrase;
    let hit = null;
    for (let i = 0; i < words.length && !hit; i++) {
      let joined = '';
      for (let j = i; j < words.length && joined.length <= want.length + 40; j++) {
        joined += simple(words[j].t);
        if (joined.includes(want)) {
          hit = words.slice(i, j + 1);
          break;
        }
      }
    }
    if (!hit && fitOf(simple(phrase.text), want)) hit = words; // nearly the same, read a little wrong
    if (!hit) continue;
    const b = boxOf(hit);
    hits.push({ type: 'text', name: phrase.text, x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
  }
  return hits;
}

/** The picture with a red ring round a point. */
function ringAt(image, cx, cy) {
  const { width, height } = image.getSize();
  const pixels = Buffer.from(image.toBitmap()); // BGRA
  const r = Math.max(14, Math.round(width / 22));
  for (let y = Math.max(0, Math.floor(cy - r - 2)); y <= Math.min(height - 1, cy + r + 2); y++) {
    for (let x = Math.max(0, Math.floor(cx - r - 2)); x <= Math.min(width - 1, cx + r + 2); x++) {
      if (Math.abs(Math.hypot(x - cx, y - cy) - r) > 1.5) continue;
      const i = (y * width + x) * 4;
      pixels[i] = 0;
      pixels[i + 1] = 0;
      pixels[i + 2] = 255;
      pixels[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height });
}

const lookAt = (system, question, image, signal) => {
  const providerId = settings.provider;
  return chat(providerId, {
    model: modelFor(providerId),
    apiKey: getKey(providerId),
    baseUrl: baseUrlFor(providerId),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question, images: [image.toJPEG(88).toString('base64')] },
    ],
    temperature: 0,
    signal,
  });
};

/** For things with no words (an arrow, an icon): the model says what it is, so it can look for it later. */
async function describeSpot(at) {
  const area = onDisplay({ x: at.x - 200, y: at.y - 110, width: 400, height: 220 }, screen.getDisplayNearestPoint(at));
  const image = await cleanCapture(area);
  const size = image.getSize();
  const marked = ringAt(image, ((at.x - area.x) / area.width) * size.width, ((at.y - area.y) / area.height) * size.height);
  const reply = await lookAt(
    'Name the thing inside the red ring in a few words, so it can be found again on a similar screen. ' +
      'Say what it is and what it looks like or says, for example: arrow button pointing right. Reply with the words only.',
    'What is inside the red ring?',
    marked,
  );
  const line = String(reply || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.replace(/^["'`*]+|["'`*.]+$/g, '').slice(0, 80) || null;
}

/** What is at a spot the user pointed at (its name and kind), so it can be found again after it moves. */
async function identify(at, { typing = false } = {}) {
  const real = screen.dipToScreenPoint(at);
  let under = await input.under(real, process.pid);
  // Browsers switch their accessibility on at the first ask, and take a moment to fill it in.
  for (let tries = 0; tries < 4 && !under.some((e) => e.w * e.h > 0 && e.type !== 'window' && e.type !== 'pane'); tries++) {
    if (tries === 0) await input.wake(real, process.pid);
    await wait(400);
    under = await input.under(real, process.pid);
  }
  if (process.env.SAGE_DEBUG) console.log('under', JSON.stringify(under.slice(0, 12)));
  const display = screen.getDisplayNearestPoint(at);
  const whole = display.size.width * display.size.height * display.scaleFactor ** 2;
  const size = (e) => e.w * e.h;
  const small = under.filter((e) => size(e) < whole * 0.15 && e.name.length <= 80).sort((a, b) => size(a) - size(b));
  if (typing) {
    const box = small.find((e) => TYPING.has(e.type));
    return box ? { name: box.name, type: box.type } : null;
  }
  // A control first (button, link, option, text box…), then a label; never a whole page or panel.
  const control = (e) => CLICKABLE.has(e.type) || TYPING.has(e.type) || ['slider', 'image', 'dataitem', 'header', 'headeritem'].includes(e.type);
  const pick = small.find(control) || small.find((e) => e.type === 'text');
  if (pick) return { name: pick.name, type: pick.type };
  // No name to go by (a game, a picture of a page): read the words there.
  try {
    // The words the spot is on, or right next to (the edge of a button round its label).
    const wordsAt = (seen) => {
      const p = real;
      const gap = (b) => Math.hypot(Math.max(b.left - p.x, 0, p.x - b.right), Math.max(b.top - p.y, 0, p.y - b.bottom));
      const nearest = seen.phrases.map((phrase) => ({ phrase, d: gap(phrase.box) })).sort((a, b) => a.d - b.d)[0];
      const close = nearest && nearest.d <= 2 * (nearest.phrase.box.bottom - nearest.phrase.box.top) && nearest.phrase.text.length <= 60;
      return close ? nearest.phrase.text : null;
    };
    const seen = await readScreen(onDisplay({ x: at.x - 160, y: at.y - 40, width: 320, height: 80 }, display), wordsAt);
    if (process.env.SAGE_DEBUG) console.log('read near the spot', JSON.stringify(seen.phrases.map((ph) => ph.text)));
    const words = wordsAt(seen);
    if (words) return { name: words, type: 'text' };
  } catch (error) {
    if (process.env.SAGE_DEBUG) console.error('read near the spot:', error.message); // try looking instead
  }
  // Nothing to read either (an arrow, an icon): remember how it looks, and what the model calls it.
  const look = await lookOf(at).catch(() => null);
  const label = await describeSpot(at).catch(() => null);
  if (!look && !label) return null;
  return { name: label || 'What you pointed at', type: 'look', look };
}

/** A grey picture of an area, one byte a pixel and one pixel a screen unit. */
async function greyOf(areaDip) {
  const w = Math.max(1, Math.round(areaDip.width));
  const h = Math.max(1, Math.round(areaDip.height));
  const bgra = (await cleanCapture(areaDip)).resize({ width: w, height: h, quality: 'good' }).toBitmap();
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) grey[i] = (bgra[i * 4] * 29 + bgra[i * 4 + 1] * 150 + bgra[i * 4 + 2] * 77) >> 8;
  return { w, h, grey };
}

/** How the spot looks: a small grey picture around it, if it has anything on it to recognise. */
async function lookOf(at) {
  const area = onDisplay({ x: Math.round(at.x) - 32, y: Math.round(at.y) - 20, width: 64, height: 40 }, screen.getDisplayNearestPoint(at));
  const { w, h, grey } = await greyOf(area);
  const mean = grey.reduce((sum, v) => sum + v, 0) / grey.length;
  const spread = Math.sqrt(grey.reduce((sum, v) => sum + (v - mean) ** 2, 0) / grey.length);
  if (spread < 10) return null; // plain background: it would match anywhere
  return { w, h, dx: Math.round(at.x - area.x), dy: Math.round(at.y - area.y), data: Buffer.from(grey).toString('base64') };
}

/** Where something that looks like `look` is in an area now (real pixels), or null. */
async function findLook(look, areaDip, near) {
  const hay = await greyOf(areaDip);
  const needle = Buffer.from(look.data, 'base64');
  const { w: pw, h: ph } = look;
  if (hay.w < pw || hay.h < ph || needle.length !== pw * ph) return null;
  // Sum of differences, given up as soon as it can't beat the best so far.
  const differ = (ox, oy, step, limit) => {
    let sum = 0;
    for (let y = 0; y < ph; y += step) {
      const row = (oy + y) * hay.w + ox;
      const own = y * pw;
      for (let x = 0; x < pw; x += step) sum += Math.abs(hay.grey[row + x] - needle[own + x]);
      if (sum >= limit) return Infinity;
    }
    return sum;
  };
  const nearX = near.x - areaDip.x - look.dx;
  const nearY = near.y - areaDip.y - look.dy;
  // A rough pass over every other spot and pixel, then a close look around the best.
  let best = { sum: Infinity, x: 0, y: 0 };
  for (let y = 0; y <= hay.h - ph; y += 2) {
    for (let x = 0; x <= hay.w - pw; x += 2) {
      const sum = differ(x, y, 2, best.sum + 400);
      // Nearly as good and nearer where it was wins.
      if (sum < best.sum - 200 || (sum < best.sum + 200 && Math.hypot(x - nearX, y - nearY) < Math.hypot(best.x - nearX, best.y - nearY))) {
        best = { sum: Math.min(sum, best.sum), x, y };
      }
    }
  }
  if (best.sum === Infinity) return null;
  let fine = { sum: Infinity, x: best.x, y: best.y };
  for (let y = Math.max(0, best.y - 2); y <= Math.min(hay.h - ph, best.y + 2); y++) {
    for (let x = Math.max(0, best.x - 2); x <= Math.min(hay.w - pw, best.x + 2); x++) {
      const sum = differ(x, y, 1, fine.sum);
      if (sum < fine.sum) fine = { sum, x, y };
    }
  }
  const average = fine.sum / (pw * ph);
  if (process.env.SAGE_DEBUG) console.log(`look found at ${fine.x},${fine.y}, off by ${average.toFixed(1)} a pixel`);
  if (average > 14) return null;
  return screen.dipToScreenPoint({ x: areaDip.x + fine.x + look.dx, y: areaDip.y + fine.y + look.dy });
}

/** Last resort: show the model the screen and the controls on it, and ask which one is meant. */
async function aiLocate(description, areaDip, signal) {
  const real = screen.dipToScreenRect(null, areaDip);
  const [image, found] = await Promise.all([
    cleanCapture(areaDip, { full: false }),
    input.elements(real, process.pid).catch(() => []),
  ]);
  const controls = found.filter((e) => e.name).slice(0, 80);
  const listed = controls.length
    ? controls.map((e, i) => `${i + 1}. ${KIND_WORDS[e.type] || e.type} "${e.name}"`).join('\n')
    : '(none could be read)';
  const reply = await lookAt(
    [
      `You find one thing on a screenshot so it can be clicked. Wanted: ${description}.`,
      'Its words or place may have changed a little since it was chosen.',
      '',
      'Controls on the screen:',
      listed,
      '',
      'Reply with one line only:',
      '- the number of the wanted control, or',
      '- at X Y: its centre as fractions of the picture (0 to 1 across, 0 to 1 down), if it is not in the list, or',
      '- none: if it is not on the screen.',
    ].join('\n'),
    'Which one is it?',
    image,
    signal,
  );
  if (process.env.SAGE_DEBUG) console.log(`locate "${description}": ${reply}`);
  const line = (String(reply || '').split('\n').map((s) => s.trim()).find(Boolean) || '').toLowerCase();
  let m = line.match(/\bat\s*\(?\s*(\d*\.?\d+)\s*[,\s]\s*(\d*\.?\d+)/);
  if (m) {
    let [fx, fy] = [Number(m[1]), Number(m[2])];
    const size = image.getSize();
    if (fx > 1 || fy > 1) [fx, fy] = [fx / size.width, fy / size.height]; // given in the picture's pixels
    if (fx > 1 || fy > 1) return null;
    return { x: real.x + fx * real.width, y: real.y + fy * real.height };
  }
  if (/\bnone\b/.test(line)) return null;
  m = line.match(/(\d{1,3})/);
  return m && controls[Number(m[1]) - 1] ? controls[Number(m[1]) - 1] : null;
}

/**
 * Find a control again, wherever it is now: by name through Windows (exact and quick), then by
 * reading the words on screen, then by asking the model. Null when it isn't there.
 */
async function locate({ name, type, look, near, area, wide, description }, signal) {
  const deadline = Date.now() + 2500; // it may still be on its way in
  if (type === 'look' && look) {
    const nearDip = screen.screenToDipPoint(near);
    for (;;) {
      const hit = await findLook(look, area, nearDip);
      if (hit) return hit;
      if (Date.now() > deadline) break;
      await pause(500, signal);
    }
  }
  if (type !== 'look') {
    const within = screen.dipToScreenRect(null, wide || screen.getDisplayMatching(area).bounds);
    for (let attempt = 0; ; attempt++) {
      let hit = bestMatch(await input.find(near, within, process.pid, name), { name, type, near });
      if (hit) return hit;
      if (attempt === 0) {
        await input.wake(near, process.pid); // browsers build their page's controls when walked through
        await pause(400, signal);
        continue;
      }
      // Keep reading until the words stand on their own (a button), not just inside a sentence.
      const want = simple(name);
      const seen = await readScreen(area, (read) => textHits(read, name).some((h) => fitOf(simple(h.name), want) >= 2));
      hit = bestMatch(textHits(seen, name), { name, type: 'text', near });
      if (hit) return hit;
      if (Date.now() > deadline) break;
      await pause(500, signal);
    }
  }
  if (signal.aborted) throw stopped();
  if (type === 'look' && !description && name === 'What you pointed at') return null; // nothing to ask about
  return aiLocate(description || describe({ name, type }), area, signal).catch((error) => {
    if (signal.aborted) throw stopped();
    if (process.env.SAGE_DEBUG) console.error('locate:', error.message);
    return null;
  });
}

/** A small picture of an area (about a third of its size), for telling whether anything changed. */
async function snapshot(areaDip) {
  const image = await captureRect(areaDip, { full: true, shrink: 3 });
  return image.resize({ width: Math.max(32, Math.min(320, Math.round(areaDip.width / 3))), quality: 'good' }).toBitmap();
}

/** Whether two snapshots differ by more than a blinking cursor or a thin outline: a line of text will do. */
function differs(a, b) {
  if (a.length !== b.length) return true;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 48) changed++;
  }
  return changed >= Math.max(12, (a.length / 4) * 0.001);
}

/** After a click: wait (up to 6 s) for the screen to change, then (up to 3 s more) for it to settle. */
async function settleAfter(area, before, signal) {
  const start = Date.now();
  let last = null;
  while (!last && Date.now() - start < 6000) {
    await pause(200, signal);
    const now = await snapshot(area);
    if (differs(before, now)) last = now;
  }
  const changedAt = Date.now() - start;
  if (!last) {
    if (process.env.SAGE_DEBUG) console.log('settle: nothing changed');
    return false;
  }
  const calm = Date.now();
  while (Date.now() - calm < 3000) {
    await pause(250, signal);
    const now = await snapshot(area);
    if (!differs(last, now)) break;
    last = now;
  }
  if (process.env.SAGE_DEBUG) console.log(`settle: changed after ${changedAt} ms, calm ${Date.now() - calm} ms later`);
  return true;
}

/** What to watch for a change after a click: the frame, and the clicked spot if it is outside it. */
function watchArea(point) {
  const frame = settings.frame;
  const inside = point.x >= frame.x - 40 && point.x <= frame.x + frame.width + 40 && point.y >= frame.y - 40 && point.y <= frame.y + frame.height + 40;
  if (inside) return onDisplay(frame);
  const left = Math.min(frame.x, point.x - 160);
  const top = Math.min(frame.y, point.y - 60);
  const right = Math.max(frame.x + frame.width, point.x + 160);
  const bottom = Math.max(frame.y + frame.height, point.y + 60);
  return onDisplay({ x: left, y: top, width: right - left, height: bottom - top }, screen.getDisplayNearestPoint(point));
}

/** Click a point (real pixels). With settle, wait until the page has changed and calmed down. */
async function press(p, { button = 'left', settle = false, signal }) {
  const dip = screen.screenToDipPoint(p);
  const watch = settle ? watchArea(dip) : null;
  // Whether the page changed after the click (null when it wasn't watched).
  return aside(watch || around(dip), async () => {
    await input.move(p.x, p.y);
    await wait(settle ? 250 : 100);
    // Taken after the pointer arrives, so a hover look doesn't count as the page changing.
    const before = watch ? await snapshot(watch).catch(() => null) : null;
    if (button === 'right') {
      await input.rightDown();
      await input.rightUp();
    } else {
      await input.down();
      await input.up();
      if (button === 'double') {
        await wait(60);
        await input.down();
        await input.up();
      }
    }
    if (!before) return null;
    return settleAfter(watch, before, signal).catch((error) => {
      if (error.code === 'aborted') throw error;
      return null;
    });
  });
}

/** Where a Click block's target is now. */
async function whereIs(step, signal) {
  const at = screen.dipToScreenPoint(step.at);
  if (!step.adaptive || !step.target) return at;
  const hit = await locate({ ...step.target, near: at, area: areaAround(step.at) }, signal);
  if (!hit) throw new AppError(`Couldn't find the ${describe(step.target)} on screen.`);
  return hit;
}

/** Runs one block. Returns whether the page changed after a click (true/false), or null. */
async function runStep(step, { answer, signal, startedAt, last, index }) {
  // Waiting for the page only helps the blocks after it.
  const settle = step.settle && !last;
  const needAnswer = () => {
    if (!answer) throw new AppError('There is no answer to use yet.');
    return answer;
  };
  switch (step.type) {
    case 'fill':
      await fillCore(needAnswer(), { signal });
      break;
    case 'click': {
      if (!step.at) throw new AppError('Point at what to click in the Click block first.');
      return press(await whereIs(step, signal), { button: step.button, settle, signal });
    }
    case 'find': {
      if (!step.text.trim()) throw new AppError('Type the words to look for in the Click by name block.');
      const frame = settings.frame;
      const centre = screen.dipToScreenPoint({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
      const area = step.where === 'screen' ? screen.getDisplayMatching(frame).bounds : frame;
      const hit = await locate(
        { name: step.text, near: centre, area, wide: area, description: `"${step.text}", or the button or link closest to it` },
        signal,
      );
      if (!hit) throw new AppError(`Couldn't find "${step.text}" on screen.`);
      if (process.env.SAGE_DEBUG) console.log(`find "${step.text}": ${hit.name || ''} (${hit.type || ''}) at ${Math.round(hit.x)}, ${Math.round(hit.y)}`);
      return press(hit, { settle, signal });
    }
    case 'type': {
      const value = step.source === 'custom' ? step.text : toPlain(needAnswer());
      if (step.at) {
        let p = screen.dipToScreenPoint(step.at);
        if (step.target) {
          // The box may have moved with a longer or shorter question.
          const display = screen.dipToScreenRect(null, screen.getDisplayNearestPoint(step.at).bounds);
          let found = await input.find(p, display, process.pid, step.target.name).catch(() => []);
          if (!found.length) {
            await input.wake(p, process.pid).catch(() => {});
            await pause(400, signal);
            found = await input.find(p, display, process.pid, step.target.name).catch(() => []);
          }
          p = bestMatch(found, { ...step.target, near: p }) || p;
        }
        await aside(around(screen.screenToDipPoint(p)), () => clickAt(p));
        await pause(150, signal);
      }
      await input.type(value);
      break;
    }
    case 'keys':
      // Esc stops a run, so let it through while this block presses it.
      if (/escape/i.test(step.keys)) releaseEscape();
      await input.combo(step.keys);
      if (/escape/i.test(step.keys) && !signal.aborted) holdEscape(filling);
      break;
    case 'wait':
      await countdown(index, step.seconds, signal);
      break;
    case 'scroll': {
      const frame = settings.frame;
      const p = screen.dipToScreenPoint({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 });
      await input.move(p.x, p.y);
      await input.wheel(step.direction === 'down' ? -step.amount : step.amount);
      break;
    }
    case 'copy':
      clipboard.writeText(toPlain(needAnswer()));
      break;
    case 'speak':
      tell('speak', toPlain(needAnswer()));
      break;
    case 'mouse': {
      const p = screen.dipToScreenPoint(startedAt);
      await input.move(p.x, p.y);
      break;
    }
  }
  return null;
}

/** Wait, showing the time left on the block. */
async function countdown(index, seconds, signal) {
  const until = Date.now() + seconds * 1000;
  if (seconds >= 2) tell('auto:wait', { index, until });
  try {
    await pause(seconds * 1000, signal);
  } finally {
    if (seconds >= 2) tell('auto:wait', { index, until: 0 });
  }
}

// ---------- Check result: was the answer marked right? ----------
// The page is read (its controls through Windows, and its words off the screen) before
// the blocks run; whatever is new after the answer is checked is what the quiz said.

const WRONG_SIGNS =
  /\b(?:incorrect(?:ly)?|wrong(?:ly)?|not\s+(?:quite|right|correct|exactly|true|it)|try\s+again|oops|sorry|nope|mistake|keep\s+(?:trying|practi[cs]ing)|almost(?:\s+there)?|unfortunately|(?:good|nice|great)\s+(?:try|attempt|effort)|(?:the\s+)?(?:correct|right)\s+answer\s*(?:is|was|would\s+be|:)|you\s+(?:missed|got\s+it\s+wrong))(?![a-z])|(?:\bnot|n[’']t)\s+(?:[a-z]+\s+){0,2}(?:correct(?:ly)?|right)(?![a-z])|[✗✘❌✖⨯]/i;
const RIGHT_SIGNS =
  /\b(?:correct(?:ly)?|right|well\s+done|great(?:\s+(?:job|work))?|good\s+(?:job|work)|nice(?:\s+(?:job|work|one))?|excellent|perfect|awesome|you\s+got\s+it|that'?s\s+it|bravo|brilliant|spot\s+on|exactly|fantastic|amazing|super|yay|nailed\s+it|keep\s+it\s+up|way\s+to\s+go)(?![a-z])|[✓✔✅☑]/i;
const INSTRUCTION =
  /\b(?:choose|select|pick|enter|write|type|find|give|circle|mark|click|tap|drag|match|spell|say|which|what|is\s+it)\b[^.!?✓✔✗✘]{0,40}?\b(?:correct(?:ly)?|right)\b(?!\s*[!.])/gi;
const AGAIN_BUTTON = /^(?:try\s+(?:it\s+)?again|retry|redo|try\s+another\s+time|reset)\b/i;

/** What one line of feedback says: the sign that comes first wins, and a tie means wrong ("Correct answer: 8"). */
function verdictOf(raw) {
  // "Choose the correct answer" is the question asking, not the quiz marking it.
  const line = raw.replace(INSTRUCTION, ' ');
  const wrong = line.search(WRONG_SIGNS);
  const right = line.search(RIGHT_SIGNS);
  if (wrong < 0 && right < 0) return null;
  if (wrong < 0) return 'right';
  if (right < 0) return 'wrong';
  return wrong <= right ? 'wrong' : 'right';
}

/** Where the quiz shows its feedback: the frame and a margin round it. */
function feedbackArea() {
  const frame = settings.frame;
  return onDisplay({ x: frame.x - 120, y: frame.y - 120, width: frame.width + 240, height: frame.height + 240 }, screen.getDisplayMatching(frame));
}

/** Every bit of text on the page: control names and the words read off the screen, plus the picture. */
async function pageText(areaDip) {
  const real = screen.dipToScreenRect(null, areaDip);
  const controls = await input.elements(real, process.pid).catch(() => []);
  let image = null;
  const seen = await readScreen(areaDip, (read) => read.phrases.length > 0, (shot) => (image = shot)).catch(() => ({ phrases: [] }));
  const lines = [];
  for (const c of controls) {
    if (c.name && c.name.length <= 300) lines.push({ text: c.name, type: c.type, x: c.x, y: c.y, from: 'ui' });
  }
  for (const phrase of seen.phrases) {
    const b = phrase.box;
    lines.push({ text: phrase.text, type: 'text', x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2, from: 'read' });
  }
  return { lines, image };
}

/** The page as it was before the blocks ran, to tell what the quiz added after. */
async function readBaseline(area) {
  // Browsers only list their page's controls once something walks through them.
  const frame = settings.frame;
  await input.wake(screen.dipToScreenPoint({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }), process.pid).catch(() => {});
  const page = await pageText(area);
  return {
    area,
    frame: { ...frame },
    keys: new Set(page.lines.map((l) => simple(l.text).replace(/\d+/g, '#'))),
    texts: page.lines.map((l) => simple(l.text)).filter((t) => t.length >= 4 && t.length <= 120),
    image: page.image,
  };
}

/** Lines that are new since the baseline. Counters ticking over, the typed answer and misreads don't count. */
function newLines(lines, baseline, answer) {
  const typed = simple(toPlain(answer || ''));
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const key = simple(line.text);
    const symbol = /[✗✘❌✖⨯✓✔✅☑]/.test(line.text);
    if ((!key && !symbol) || seen.has(key + line.text)) continue;
    if (baseline.keys.has(key.replace(/\d+/g, '#'))) continue;
    if (key && key === typed) continue;
    // Read off the screen, the same words can come out a letter or two different.
    const near = (old) => Math.abs(old.length - key.length) <= Math.max(2, key.length / 5) && distance(old, key) <= Math.max(1, Math.floor(key.length / 6));
    if (line.from === 'read' && key.length >= 4 && key.length <= 120 && baseline.texts.some(near)) continue;
    seen.add(key + line.text);
    out.push(line);
  }
  return out;
}

const hueOf = (b, g, r) => (g > r + 50 && g > b + 25 && g > 90 ? 'g' : r > g + 60 && r > b + 45 && r > 110 ? 'r' : '');

/** Only the frame's part of a picture of the feedback area: what is round it (a desktop, other apps) can change on its own. */
function frameOf(image, baseline) {
  const size = image.getSize();
  const { area, frame } = baseline;
  const k = size.width / area.width;
  const x = Math.max(0, Math.round((frame.x - area.x) * k));
  const y = Math.max(0, Math.round((frame.y - area.y) * k));
  return image.crop({ x, y, width: Math.min(size.width - x, Math.round(frame.width * k)), height: Math.min(size.height - y, Math.round(frame.height * k)) });
}

/** Did things in the frame turn green or red since the baseline? */
function colourVerdict(baseline, after) {
  if (!baseline.image || !after) return null;
  const width = 320;
  const a = frameOf(baseline.image, baseline).resize({ width, quality: 'good' });
  const b = frameOf(after, baseline).resize({ width, height: a.getSize().height, quality: 'good' });
  const [was, now] = [a.toBitmap(), b.toBitmap()];
  if (was.length !== now.length) return null;
  let green = 0;
  let red = 0;
  for (let i = 0; i < now.length; i += 4) {
    const hue = hueOf(now[i], now[i + 1], now[i + 2]);
    if (!hue || hue === hueOf(was[i], was[i + 1], was[i + 2])) continue;
    if (hue === 'g') green += 1;
    else red += 1;
  }
  const least = Math.max(15, (now.length / 4) * 0.002);
  if (process.env.SAGE_DEBUG) console.log(`colour: ${green} turned green, ${red} turned red (need ${Math.round(least)})`);
  // Strong: a whole box or bar changed colour, with hardly any of the other.
  if (green >= least && green > red * 3) return { result: 'right', strong: green >= least * 4 && green > red * 10 };
  if (red >= least && red > green * 3) return { result: 'wrong', strong: red >= least * 4 && red > green * 10 };
  return null;
}

/** When the page has no words for it: show the model, and ask. */
async function askVerdict(image, answer, said, signal) {
  if (!image) return null;
  const size = image.getSize();
  const picture = size.width > MAX_IMAGE_WIDTH ? image.resize({ width: MAX_IMAGE_WIDTH, quality: 'best' }) : image;
  const reply = await lookAt(
    [
      'A quiz answer was just checked. Look at the screenshot and say whether the quiz marked it right or wrong.',
      `The answer given was: ${toPlain(answer || '') || '(not known)'}`,
      said.length ? `Text that appeared after checking: ${said.slice(0, 12).map((s) => `"${text(s, 160)}"`).join(', ')}` : '',
      'Look for words like correct or wrong, ticks or crosses, and green or red highlights.',
      'Reply with one word: right, wrong, or unknown (if the page does not show it).',
    ]
      .filter(Boolean)
      .join('\n'),
    'Was it marked right or wrong?',
    picture,
    signal,
  );
  const word = (String(reply || '').toLowerCase().match(/\b(right|correct|wrong|incorrect|unknown)\b/) || [])[1];
  if (word === 'right' || word === 'correct') return 'right';
  if (word === 'wrong' || word === 'incorrect') return 'wrong';
  return null;
}

/** Was it marked right? 'right', 'wrong' or 'unknown', with what the quiz said. */
async function judge(run) {
  let fresh = [];
  let image = null;
  for (let look = 0; look < 3; look++) {
    if (look) await pause(700, run.signal); // feedback can take a moment to appear
    const page = await pageText(run.baseline.area);
    image = page.image;
    fresh = newLines(page.lines, run.baseline, run.answer);
    let marks = fresh.map((l) => verdictOf(l.text)).filter(Boolean);
    // After a retry the old "Incorrect" can still be there next to the new feedback: the new one counts.
    if (run.lastSaid && marks.includes('right') && marks.includes('wrong')) {
      const newer = fresh.filter((l) => !run.lastSaid.has(simple(l.text))).map((l) => verdictOf(l.text)).filter(Boolean);
      if (newer.length) marks = newer;
    }
    const right = marks.includes('right');
    const wrong = marks.includes('wrong');
    if (process.env.SAGE_DEBUG) console.log(`judge ${look}: new ${JSON.stringify(fresh.map((l) => l.text))} -> ${marks.join(',') || 'nothing'}`);
    if (right !== wrong) return { result: right ? 'right' : 'wrong', fresh, how: 'words' };
    if (right && wrong) break; // mixed: let the model look
  }
  const said = fresh.map((l) => l.text);
  const tint = colourVerdict(run.baseline, image);
  if (tint && tint.strong && !said.some((s) => verdictOf(s))) return { result: tint.result, fresh, how: 'colour' };
  const colour = tint && tint.result;
  const seen = await askVerdict(image && frameOf(image, run.baseline), run.answer, said, run.signal).catch((error) => {
    if (run.signal.aborted) throw stopped();
    if (process.env.SAGE_DEBUG) console.error('verdict:', error.message);
    return null;
  });
  // The model alone saying "wrong" isn't enough to change an answer when the colours say right.
  if (seen && !(seen === 'wrong' && colour === 'right')) return { result: seen, fresh, how: 'look' };
  if (colour) return { result: colour, fresh, how: 'colour' };
  return { result: 'unknown', fresh, how: 'none' };
}

/** "The correct answer is 8": the answer the quiz gave away, if it did and it isn't the one just given. */
function revealed(fresh, given) {
  for (const line of fresh) {
    const m = line.text.match(/\b(?:correct|right)\s+answer\s*(?:is|was|would\s+(?:have\s+)?be(?:en)?|:)\s*[:\-–—]?\s*["“']?([^"”'\n]{1,80}?)["”']?\s*[.!]?\s*$/i);
    if (!m) continue;
    const value = m[1].trim();
    if (value && !sameAnswer(value, given || '')) return value;
  }
  return null;
}

/** A "Try again" button that appeared with the feedback, if there is one. */
function againButton(fresh) {
  return fresh.find((l) => AGAIN_BUTTON.test(l.text.trim()) && (CLICKABLE.has(l.type) || (l.from === 'read' && l.text.trim().length <= 16)));
}

/**
 * Check result: read what the quiz said. If it was wrong, get a new answer (with what the quiz said),
 * press "Try again" if there is one, and run the blocks before this one again; up to `tries` times.
 */
async function verifyStep(step, index, run) {
  for (let attempt = 0; ; attempt++) {
    const verdict = await judge(run);
    if (process.env.SAGE_DEBUG) console.log(`verdict: ${verdict.result} (${verdict.how})`);
    tell('auto:verdict', { index, result: verdict.result, attempt });
    if (verdict.result !== 'wrong') {
      if (verdict.result === 'unknown') tell('toast', "Couldn't tell if it was right.");
      return;
    }
    if (step.onWrong === 'stop') throw new AppError('The quiz marked it wrong, so the blocks stopped.');
    if (step.onWrong === 'continue') return;
    if (attempt >= step.tries) {
      tell('toast', `Still wrong after ${step.tries} ${step.tries === 1 ? 'try' : 'tries'}.`);
      return;
    }
    // A new answer: the one the quiz showed, or else worked out again. Esc stops it too.
    const shown = revealed(verdict.fresh, run.answer);
    let reply;
    if (shown) reply = takeAnswer(shown);
    else {
      const stopAnswer = () => running && running.abort();
      run.signal.addEventListener('abort', stopAnswer);
      try {
        reply = await rethink({ said: verdict.fresh.map((l) => l.text).slice(0, 8) });
      } finally {
        run.signal.removeEventListener('abort', stopAnswer);
      }
    }
    if (run.signal.aborted) throw stopped();
    if (!reply) throw new AppError("Couldn't get a new answer.");
    run.answer = latestAnswer();
    run.lastSaid = new Set(verdict.fresh.map((l) => simple(l.text)));
    try {
      const again = againButton(verdict.fresh);
      if (again) await press({ x: again.x, y: again.y }, { settle: true, signal: run.signal });
      for (let j = 0; j < index; j++) {
        const block = run.list[j];
        if (block.type === 'verify' || block.type === 'repeat') continue;
        run.report(j);
        await runStep(block, { ...run, index: j, last: false });
        await pause(150, run.signal);
      }
    } catch (error) {
      if (run.signal.aborted || error.code === 'aborted') throw error;
      tell('toast', "Couldn't answer again on this page.");
      return;
    }
    run.report(index);
  }
}

// ---------- the run ----------

let chain = null; // { left, total, done } while Keep going answers question after question

function runSteps({ chained = false } = {}) {
  const list = settings.steps.list;
  if (!list.length) return;
  if (!chained) chain = null;
  const startedAt = screen.getCursorScreenPoint();
  let nextQuestion = false;
  let finished = false;
  automate('steps', async (controller, report) => {
    const run = { list, report, answer: latestAnswer(), signal: controller.signal, startedAt, lastChange: null, baseline: null };
    if (list.some((s) => s.type === 'verify')) run.baseline = await readBaseline(feedbackArea());
    for (let i = 0; i < list.length; i++) {
      if (controller.signal.aborted) throw stopped();
      const step = list[i];
      report(i);
      if (step.type === 'verify') {
        await verifyStep(step, i, run);
      } else if (step.type === 'repeat') {
        if (!chain) chain = { left: step.count, total: step.count, done: 0 };
        if (run.lastChange === false) {
          chain = null;
          tell('toast', "The page didn't change, so Keep going stopped.");
        } else if (chain.left <= 0) {
          chain = null;
        } else {
          chain.left -= 1;
          chain.done += 1;
          if (step.seconds) await countdown(i, step.seconds, controller.signal);
          nextQuestion = true;
        }
      } else {
        const changed = await runStep(step, { ...run, index: i, last: i === list.length - 1 });
        if (step.type === 'click' || step.type === 'find') run.lastChange = changed;
      }
      await pause(150, controller.signal);
    }
    finished = true;
    return list.length;
  }).then(() => {
    if (!finished || !nextQuestion || !chain) {
      if (!finished) chain = null;
      return;
    }
    tell('toast', `Next question (${chain.done} of ${chain.total})`);
    ask({ chained: true });
  });
}

// ---------- picking a spot on screen ----------

let picking = null; // { resolve } while the user picks a spot for a block

function startPick() {
  if (picking) endPick(null);
  if (selecting) endSelect(null);
  // Wake the page's accessibility now, so what gets pointed at can be named straight away.
  const frame = settings.frame;
  input.wake(screen.dipToScreenPoint({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }), process.pid).catch(() => {});
  return new Promise((resolve) => {
    picking = { resolve };
    clearTimeout(hideTimer);
    showOverlays();
    for (const win of overlays) win.setIgnoreMouseEvents(false);
    // The widget fades and lets clicks through, so the spot can be under it too.
    if (widget && !widget.isDestroyed()) {
      widget.setOpacity(0.25);
      widget.setIgnoreMouseEvents(true);
    }
    try {
      globalShortcut.register('Escape', () => endPick(null));
    } catch {
      // Esc is taken; a right-click still cancels.
    }
    broadcastFrame();
  });
}

function endPick(point) {
  if (!picking) return;
  const { resolve } = picking;
  picking = null;
  globalShortcut.unregister('Escape');
  for (const win of overlays) win.setIgnoreMouseEvents(true, { forward: true });
  if (widget && !widget.isDestroyed()) {
    widget.setIgnoreMouseEvents(false);
    widget.setOpacity(1);
  }
  broadcastFrame();
  if (!settings.frameVisible) {
    hideTimer = setTimeout(() => {
      if (!settings.frameVisible && !picking) for (const win of overlays) win.hide();
    }, 280);
  }
  raiseFloating();
  resolve(cleanPoint(point));
}

/**
 * Pick a spot for a block. A click learns what is there (a button's name and kind) so it can find it
 * again when it moves; typing learns the text box; a bare spot learns nothing.
 */
async function pickSpot(kind) {
  const at = await startPick();
  if (!at) return null;
  if (kind !== 'click' && kind !== 'type') return { at, target: null };
  const target = await identify(at, { typing: kind === 'type' }).catch((error) => {
    if (process.env.SAGE_DEBUG) console.error('identify:', error.message);
    return null;
  });
  if (process.env.SAGE_DEBUG) console.log('picked', at, target);
  return { at, target };
}

// ---------- tray ----------

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`ScreenSage (${hotkeyLabel()})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Answer', click: () => ask() },
      { label: 'Select area', click: startSelect },
      { type: 'separator' },
      { label: 'Show frame', type: 'checkbox', checked: settings.frameVisible, click: (item) => setFrameVisible(item.checked) },
      { label: 'Shade outside the frame', type: 'checkbox', checked: settings.frameStyle.shade, click: (item) => setShade(item.checked) },
      { label: 'Timer', type: 'checkbox', checked: !!timerWin, click: toggleTimer },
      { type: 'separator' },
      { label: 'Show', click: showWidget },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(appIcon(32));
  tray.on('click', showWidget);
  refreshTray();
}

// ---------- shortcut ----------

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  try {
    return globalShortcut.register(accelerator, () => ask());
  } catch {
    return false;
  }
}

// ---------- messages from the windows ----------

const isFrom = (win, event) => win && !win.isDestroyed() && event.sender === win.webContents;
const fromWidget = (event) => isFrom(widget, event);
const overlayOf = (event) => [...overlays].find((win) => isFrom(win, event));

function applyPrefs(section, before) {
  const now = settings[section];
  if (section === 'behaviour') {
    if (now.launchAtLogin !== before.launchAtLogin && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: now.launchAtLogin });
    }
    if (now.hotkey !== before.hotkey) {
      globalShortcut.unregister(before.hotkey);
      if (globalShortcut.register(now.hotkey, () => ask())) {
        hotkeyWorks = true;
      } else {
        settings.behaviour.hotkey = before.hotkey;
        hotkeyWorks = registerHotkey(before.hotkey);
        return 'That shortcut is already used by another app.';
      }
    }
  }
  return '';
}

function registerIpc() {
  ipcMain.handle('state', () => publicState());

  ipcMain.handle('provider:set', (event, providerId) => {
    if (fromWidget(event) && PROVIDERS[providerId]) {
      settings.provider = providerId;
      saveSettings();
    }
    return publicState();
  });

  ipcMain.handle('model:set', (event, providerId, model) => {
    if (fromWidget(event) && PROVIDERS[providerId]) {
      settings.models[providerId] = text(model, 200);
      saveSettings();
    }
    return publicState();
  });

  ipcMain.handle('key:set', (event, providerId, key) => {
    if (!fromWidget(event) || !PROVIDERS[providerId]) return { ok: false, error: 'Unknown provider.' };
    try {
      setKey(providerId, text(key, 500).trim());
      return { ok: true, state: publicState() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('baseurl:set', (event, providerId, url) => {
    if (!fromWidget(event) || !PROVIDERS[providerId]) return { ok: false, error: 'Unknown provider.' };
    const value = text(url, 300).trim();
    if (!value || value === PROVIDERS[providerId].baseUrl) {
      delete settings.baseUrls[providerId];
    } else if (/^https?:\/\/[^\s]+$/i.test(value)) {
      settings.baseUrls[providerId] = value.replace(/\/+$/, '');
    } else {
      return { ok: false, error: 'The address must start with http:// or https://' };
    }
    saveSettings();
    return { ok: true, state: publicState() };
  });

  ipcMain.handle('models:list', async (event, providerId) => {
    if (!fromWidget(event) || !PROVIDERS[providerId]) return { ok: false, error: 'Unknown provider.' };
    try {
      const models = await listModels(providerId, { apiKey: getKey(providerId), baseUrl: baseUrlFor(providerId) });
      // Nothing chosen yet (or the choice is gone): pick a sensible model.
      if (models.length && !models.includes(modelFor(providerId))) {
        settings.models[providerId] = suggestModel(models);
        saveSettings();
      }
      return { ok: true, models, state: publicState() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('prefs:set', (event, section, patch) => {
    const allowed = fromWidget(event) || (section === 'timer' && isFrom(timerWin, event));
    if (!allowed || !SECTIONS.includes(section)) return { error: 'Unknown setting.', state: publicState() };
    const before = settings[section];
    settings[section] = sanitize(section, patch, before);
    const error = applyPrefs(section, before);
    saveSettings();
    return { error, state: broadcast() };
  });

  ipcMain.handle('history:list', (event) => (fromWidget(event) ? history : []));
  ipcMain.handle('history:delete', (event, id) => {
    if (fromWidget(event)) {
      history = history.filter((item) => item.id !== id);
      removeCapture(id);
      saveHistory();
    }
    return history;
  });

  ipcMain.handle('storage:info', (event) => (fromWidget(event) ? storageInfo() : null));
  ipcMain.handle('storage:clear-recents', (event) => {
    if (fromWidget(event)) clearRecents();
    return storageInfo();
  });
  ipcMain.handle('storage:delete-all', (event) => {
    if (fromWidget(event)) deleteAllData();
    return storageInfo();
  });

  ipcMain.on('ask', (event) => fromWidget(event) && ask());
  ipcMain.on('retry', (event) => fromWidget(event) && retry());
  ipcMain.on('followup', (event, question) => fromWidget(event) && followUp(question));
  ipcMain.on('stop', (event) => {
    if (!fromWidget(event)) return;
    if (running) running.abort();
    if (filling) filling.abort();
  });
  ipcMain.on('fill', (event) => fromWidget(event) && fillIn());
  ipcMain.handle('steps:set', (event, value) => {
    if (!fromWidget(event)) return null;
    settings.steps = cleanSteps(value, settings.steps);
    saveSettings();
    return settings.steps;
  });
  ipcMain.handle('steps:pick', (event, kind) => (fromWidget(event) && !filling ? pickSpot(String(kind)) : null));
  ipcMain.on('steps:run', (event) => fromWidget(event) && runSteps());
  ipcMain.handle('model:download', (event, providerId, model) => {
    if (!fromWidget(event) || !PROVIDERS[providerId]) return { ok: false, error: 'Unknown provider.' };
    return startDownload(providerId, text(model, 300));
  });
  ipcMain.on('model:download-stop', (event) => fromWidget(event) && downloading && downloading.controller.abort());
  ipcMain.handle('update:check', (event) => (fromWidget(event) ? checkUpdate() : null));
  ipcMain.handle('update:install', (event) => (fromWidget(event) ? installUpdate() : null));
  ipcMain.on('copy', (event, value) => fromWidget(event) && clipboard.writeText(toPlain(text(value, 200000))));
  ipcMain.on('image:open', (event, id) => fromWidget(event) && openImage(text(id, 40)));
  ipcMain.on('frame:toggle', (event) => fromWidget(event) && setFrameVisible(!settings.frameVisible));
  ipcMain.on('frame:select', (event) => fromWidget(event) && startSelect());
  ipcMain.on('timer:toggle', (event) => fromWidget(event) && toggleTimer());
  ipcMain.on('positions:reset', (event) => fromWidget(event) && resetPositions());
  ipcMain.on('widget:height', (event, height) => fromWidget(event) && setWidgetHeight(Number(height)));
  ipcMain.on('window:close', (event) => fromWidget(event) && widget.close());

  ipcMain.on('key:open-page', (event, providerId) => {
    // Only ever open the provider's own key page, never a URL from the window.
    const info = PROVIDERS[providerId];
    if (fromWidget(event) && info && info.keyUrl) shell.openExternal(info.keyUrl);
  });

  // Timer
  ipcMain.on('timer:close', (event) => isFrom(timerWin, event) && timerWin.close());
  ipcMain.on('timer:focus', (event) => isFrom(timerWin, event) && timerWin.focus());
  ipcMain.on('timer:drag-start', (event) => isFrom(timerWin, event) && startWindowDrag(timerWin));
  ipcMain.on('timer:drag-end', (event) => isFrom(timerWin, event) && stopWindowDrag());

  // Image viewer
  ipcMain.on('viewer:close', (event) => isFrom(viewer, event) && viewer.close());

  // Frame overlays
  ipcMain.on('overlay:ignore', (event, ignore) => {
    const win = overlayOf(event);
    if (win && !dragging && !selecting && !filling && !picking) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('overlay:rect', (event, rect, final) => {
    const win = overlayOf(event);
    const hole = cleanRect(rect);
    if (!win || !hole) return;
    settings.frame = hole;
    dragging = !final;
    if (!final) {
      broadcastFrame(win); // the window doing the dragging already shows it
      return;
    }
    if (!validHole(hole)) settings.frame = defaultHole();
    saveSettings();
    broadcastFrame();
    raiseFloating();
  });
  ipcMain.on('overlay:select', (event, rect, final) => {
    const win = overlayOf(event);
    if (!win || !selecting) return;
    if (final) {
      endSelect(rect);
      return;
    }
    selection = cleanRect(rect, true);
    broadcastFrame(win);
  });
  ipcMain.on('overlay:pick', (event, point) => {
    if (overlayOf(event) && picking) endPick(point);
  });
  ipcMain.on('overlay:action', (event, action) => {
    if (!overlayOf(event)) return;
    if (action === 'shade') setShade(!settings.frameStyle.shade);
    if (action === 'hide') setFrameVisible(false);
    if (action === 'select') startSelect();
  });
}

// ---------- start ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('app.screensage.desktop');
  app.on('second-instance', showWidget);
  app.on('before-quit', () => {
    quitting = true;
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    loadSettings();
    if (!validHole(settings.frame)) settings.frame = defaultHole();
    registerIpc();
    createWidget();
    buildOverlays();
    createTray();
    hotkeyWorks = registerHotkey(settings.behaviour.hotkey);
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(name, screensChanged);
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    input.stop();
  });
  app.on('window-all-closed', () => app.quit());
}
