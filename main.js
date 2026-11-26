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
    'your answer here',
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
    'What goes in <answer>:',
    '- Only the final answer: the value, the option, the word or one short sentence. Never repeat the question or its instructions.',
    '- If the question tells you to do something, give what to do it to: for "Click the red circle" the answer is "The red circle", and for "Set the slider to 70" it is "70".',
    '- Several separate questions, boxes or gaps: one answer per line, in order.',
    '- Several options to pick: each on its own line.',
    '- Matching, or sorting things into groups: each pair on its own line, like "Dog → Mammals".',
    '- Putting things in order: one per line, numbered, like "1. first" then "2. second".',
    '- A word written one letter to a box: the whole word.',
    '- A switch or toggle: "On" or "Off", how it should end up, not how it is now.',
    `If there is no question in the capture, put a one-sentence description of what it shows in <answer> and leave ${explain ? 'the other sections' : '<working>'} empty.`,
    'Formatting: write all maths in LaTeX, inline as $...$ and on its own line as $$...$$ (for example $\\frac{3}{4}$, $x^2 + 1$, $\\sqrt{2}$, $45^\\circ$, $3 \\times 4$). Use Markdown for the rest: **bold** for the key value, short numbered steps, a table only when it really helps.',
  ].join('\n');

// Added when a model keeps second-guessing itself and the thinking starts over.
// A reply that only copied the format back isn't an answer.
const BAD_ANSWER = /^(?:your answer here|the final answer only)/i;
const goodAnswer = (reply) => {
  const answer = answerOf(reply);
  return !!answer && !BAD_ANSWER.test(answer);
};

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
  group: 'box', image: 'picture', custom: 'item', menuitem: 'menu item', tabitem: 'tab', splitbutton: 'button', place: 'place to drop into', shape: 'coloured shape',
};
// Buttons that would hand the answer in. Fill in never presses these.
const SUBMIT_WORDS = /\b(submit|next|finish|check|send|done|continue|save|turn in|hand in)\b/i;

/** Where a point (real pixels) is on the 0–1000 grid of the frame. */
function onGrid(rect, p) {
  const dip = screen.screenToDipPoint(p);
  const g = (v, start, size) => Math.min(1000, Math.max(0, Math.round(((v - start) / size) * 1000)));
  return `${g(dip.x, rect.x, rect.width)},${g(dip.y, rect.y, rect.height)}`;
}

function describeElement(e, index, rect) {
  let line = `#${index + 1}: ${KIND_NAMES[e.type] || e.type} "${text(e.name, 140)}"`;
  if (e.type === 'edit' || e.type === 'combobox' || e.type === 'spinner') line += ` holding "${text(e.value, 80)}"`;
  if (e.type === 'slider' && e.max != null) line += ` set to ${e.value} (goes from ${e.min} to ${e.max})`;
  if (e.state) line += ` (${e.state})`;
  if (rect) line += ` at ${onGrid(rect, e)}`;
  return line;
}

const usable = (elements) => elements.some((e) => e.type !== 'text' || e.name.length <= 40);

const fillPrompt = (answer, elements, rect, before) =>
  [
    'You are entering an answer into the question shown in this screen capture, using the mouse and keyboard.',
    `The answer to enter:\n${toPlain(answer)}`,
    'First work out what kind of question it is and how it takes its answer, then do exactly that. For example:',
    '- a text or number box: type the answer in it (several boxes: each part in its own box)',
    '- options to pick (one, or several "select all that apply"): click each one that is part of the answer, and only those',
    '- cards or words to drag into boxes, gaps, a list or an order: drag each one to its place, one drag per card (things listed as "place to drop into" are the empty boxes and gaps, in order from top left)',
    '- matching pairs: drag each one onto its partner (only if dragging did nothing last time, click one and then its partner)',
    '- a dropdown: choose the entry; a slider or number line: drag the handle or click the spot',
    '- a picture or map to click on: click the right spot',
    'The answer may be written differently from how the question wants it (a list, arrows, letters, words): turn it into what this question needs.',
    'Positions are on a 0 to 1000 grid over the capture: x across from the left edge, y down from the top edge.',
    'The capture has faint blue grid lines every 100, numbered along its top and right edges, and a small dark tag with each thing\'s number by its top-left corner. For a place with no number (an empty box or gap, a spot on a picture), read its position off the grid lines.',
    ...(usable(elements)
      ? [
          'These are the things inside the capture you can use. Each has a number after # (not part of its name), and where it is on the grid:',
          ...elements.map((e, i) => describeElement(e, i, rect)),
        ]
      : ['Nothing in the capture could be read as a control, so use positions.']),
    'Reply with commands only, one per line, nothing else. The commands are:',
    ...(usable(elements) && !elements.some((e) => TYPING.has(e.type))
      ? ['There are no text boxes here, so do not type: click, choose or drag instead.']
      : []),
    ...(usable(elements)
      ? [
          '- click #N : click thing #N',
          '- type #N <text> : put <text> into text box #N, replacing what is there',
          '- choose #N <entry> : pick <entry> in dropdown #N',
          '- drag #N #M : drag thing #N onto thing #M',
          '- drag "<words>" to "<words>" : the same, naming both things by the exact words in the list (best for cards: drag "Berlin" to "Germany", drag "3" to "empty box 1")',
          '- drag #N X Y : drag thing #N to a place that is not in the list',
          'Always write the # before a thing\'s number, so "click #4" clicks thing #4 and never an option called 4.',
        ]
      : []),
    '- click X Y : click at a position (aim for the centre)',
    '- type <text> : type into the box that was just clicked',
    '- drag X1 Y1 X2 Y2 : drag from one position to another',
    '- key enter : press a key (enter, tab, down or up)',
    '- look : stop and get a new capture first (for example after opening a custom list)',
    '- done : the answer is fully entered',
    'Rules: only enter the answer, never press submit, next, check or finish. Leave anything that is already right alone (do not click a ticked box again). Use the answer as given.',
    ...(before ? [`On the question before this one, the answer went in with: ${before}. Use that again only if this question works the same way.`] : []),
    'An example reply, for a different question:',
    ...(usable(elements) ? ['type #3 42', 'click #7', 'drag #9 #12', 'drag #10 455 620', 'click 300 210', 'done'] : ['click 412 388', 'type 42', 'done']),
    'Only use numbers that are in the list above. Anything without a number (an empty box, a gap, a spot on a picture) is X Y from the grid: two numbers, like drag #10 455 620 or click 300 210.',
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

// ---------- fading our windows ----------
// Our windows never blink in and out of sight: they fade.

const fading = new Map(); // window -> { timer, resolve }

/** Fade a window to an opacity. Resolves once it is there (at once if it is hidden). */
function fadeTo(win, to, ms = 200) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  const current = fading.get(win);
  if (current) {
    clearInterval(current.timer);
    fading.delete(win);
    current.resolve();
  }
  const from = win.getOpacity();
  if (Math.abs(from - to) < 0.005 || !win.isVisible() || ms <= 0) {
    win.setOpacity(to);
    return Promise.resolve();
  }
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(timer);
        fading.delete(win);
        return resolve();
      }
      const t = Math.min(1, (Date.now() - started) / ms);
      win.setOpacity(from + (to - from) * t * t * (3 - 2 * t));
      if (t >= 1) {
        clearInterval(timer);
        fading.delete(win);
        resolve();
      }
    }, 15);
    fading.set(win, { timer, resolve });
  });
}

// A run keeps our windows still. Whatever is over the frame fades out once and stays out until
// the run is over (Keep going counts as one run); everything else doesn't change at all.
let frameQuiet = false;
let frameBack = null;
let runEnded = 0;
const steady = { on: false, out: new Set() };

/** Windows over the frame fade out once, and let clicks through until the run is over. */
async function stepOut(wins) {
  const fresh = wins.filter((win) => !steady.out.has(win));
  if (!fresh.length) return;
  for (const win of fresh) {
    steady.out.add(win);
    win.setIgnoreMouseEvents(true);
  }
  await Promise.all(fresh.map((win) => fadeTo(win, 0, 240)));
  await wait(60);
}

/** The run is over: anything that stepped out comes back. */
function letGo() {
  steady.on = false;
  for (const win of steady.out) {
    if (win.isDestroyed()) continue;
    win.setIgnoreMouseEvents(false);
    fadeTo(win, 1, 320);
  }
  steady.out.clear();
  if (frameQuiet) {
    frameQuiet = false;
    for (const win of overlays) fadeTo(win, OVERLAY_OPACITY, 340);
  }
}

/** A picture taken during a run, with our own windows that are still showing painted out of it. */
function coverOurs(image, areaDip) {
  if (!steady.on) return image;
  const wins = [widget, timerWin, viewer].filter((win) => win && !win.isDestroyed() && win.isVisible() && !steady.out.has(win) && overlapArea(win.getBounds(), areaDip) > 0);
  if (!wins.length) return image;
  const { width: W, height: H } = image.getSize();
  const px = Buffer.from(image.toBitmap());
  const [kx, ky] = [W / areaDip.width, H / areaDip.height];
  for (const win of wins) {
    const b = win.getBounds();
    const x0 = Math.max(0, Math.floor((b.x - areaDip.x) * kx));
    const x1 = Math.min(W - 1, Math.ceil((b.x + b.width - areaDip.x) * kx));
    const y0 = Math.max(0, Math.floor((b.y - areaDip.y) * ky));
    const y1 = Math.min(H - 1, Math.ceil((b.y + b.height - areaDip.y) * ky));
    const from = (Math.min(H - 1, y0) * W + (x0 > 0 ? x0 - 1 : Math.min(W - 1, x1 + 1))) * 4;
    const [cb, cg, cr] = [px[from], px[from + 1], px[from + 2]];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 4;
        px[i] = cb;
        px[i + 1] = cg;
        px[i + 2] = cr;
      }
    }
  }
  return nativeImage.createFromBitmap(px, { width: W, height: H });
}

async function quietFrame() {
  clearTimeout(frameBack);
  frameQuiet = true;
  await Promise.all([...overlays].map((win) => fadeTo(win, 0, 260)));
  await wait(60);
}

function frameReturns(delay = 700) {
  clearTimeout(frameBack);
  frameBack = setTimeout(() => {
    if (filling || picking) return;
    // The next question of a Keep going run is being answered, or about to be.
    if (chain && (running || Date.now() - runEnded < 2500)) return frameReturns(delay);
    letGo();
  }, delay);
}

/** Capture the frame. Any of our windows in the way fade aside for a moment. */
async function captureFrame() {
  const inTheWay = [widget, timerWin].filter(
    (win) => win && !win.isDestroyed() && win.isVisible() && overlapArea(win.getBounds(), settings.frame) > 0,
  );
  if (steady.on) {
    await stepOut(inTheWay);
    return captureRect(settings.frame);
  }
  if (inTheWay.length) {
    await Promise.all(inTheWay.map((win) => fadeTo(win, 0, 180)));
    await wait(60);
  }
  try {
    return await captureRect(settings.frame);
  } finally {
    for (const win of inTheWay) fadeTo(win, 1, 240);
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
          temperature: repeats ? Math.min(1, (temperature ?? 0.2) + 0.3 * repeats) : (temperature ?? 0),
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
        if (!goodAnswer(reply) && repeats < 2) {
          repeats += 1;
          tell('answer:rethink', 'repeat');
          continue;
        }
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

// A follow-up that only asks about the answer ("why?", "how did you get that?") gets a reply and
// leaves the answer as it is. Anything else ("make it more niche", "shorter", "in French") changes it.
const JUST_ASKING =
  /^\s*(?:why|how(?!\s+about)|what\s+(?:does|do|is|are|did|was|were)\b|explain|can\s+you\s+explain|could\s+you\s+explain|are\s+you\s+sure|is\s+(?:that|it|this)\s+(?:right|correct|true)|where\s+did|tell\s+me\s+(?:why|how|more\s+about)|so\s+(?:why|how)|wdym|huh)\b/i;

/** The answers given to the question so far (not replies to "why?"). */
function givenAnswers(fromIndex) {
  const out = [];
  for (const m of conversation.slice(fromIndex)) {
    const answer = m.role === 'assistant' && !m.talk ? answerOf(m.content) : '';
    if (answer && !out.some((a) => sameAnswer(a, answer))) out.push(answer);
  }
  return out;
}

const followUp = (input) => {
  const said = text(input, 2000).trim();
  if (!said || !conversation || running) return;
  const asking = JUST_ASKING.test(said) && !/\b(?:change|instead|another|different|more|less|make\s+it)\b/i.test(said);
  const earlier = givenAnswers(1);
  const current = latestAnswer();
  const note = asking
    ? [
        `The user asks about your answer: "${said}"`,
        'Reply to them in <answer>, briefly and plainly. Keep the same final answer unless they show it is wrong.',
      ].join('\n')
    : [
        `The user wants the answer changed: "${said}"`,
        `Your current answer is: ${current}`,
        'Give a NEW answer in <answer> that does exactly what they ask (for example: more niche means rarer and more specific; shorter means fewer words; another means a different one).',
        `It must be different from ${earlier.length > 1 ? 'every answer given so far' : 'the current answer'}${earlier.length > 1 ? `: ${earlier.join('; ')}` : ''}, unless they ask to keep it.`,
        'Keep the same reply format as before.',
      ].join('\n');
  const index = conversation.length;
  const build = ({ repeats } = {}) =>
    conversation.map((m, i) =>
      i === index
        ? { role: 'user', content: `${note}${repeats ? '\nYou gave the same answer again. Give a different one that does what they ask.' : ''}` }
        : { role: m.role, content: m.content, ...(m.images ? { images: m.images } : {}) },
    );
  sendAfter(said, 'answer:followup', said, {
    build,
    temperature: asking ? undefined : 0.7,
    rejects: asking ? undefined : (answer) => earlier.some((a) => sameAnswer(a, answer)),
  }).then((reply) => {
    if (!reply || !asking) return;
    // A reply to "why?" isn't a new answer: Fill in and the blocks keep using the answer before it.
    const last = conversation[conversation.length - 1];
    const question = conversation[conversation.length - 2];
    if (last && last.role === 'assistant') last.talk = true;
    if (question && question.role === 'user') question.talk = true;
  });
};

/**
 * Wrong answer: ask the same question again from scratch, without the wrong
 * reasoning in view, listing every answer that was wrong. Fresh thinking, a
 * little more variety, and a reply that only repeats a wrong answer is asked again.
 */
function rethink({ said = [] } = {}) {
  if (!conversation || running || conversation[conversation.length - 1].role !== 'assistant') return Promise.resolve(null);
  let question = conversation.length - 1;
  while (question > 0 && !(conversation[question].role === 'user' && conversation[question].content !== RETRY && !conversation[question].talk)) question -= 1;
  const rejected = [];
  // After a follow-up like "make it more niche", the answers before it are out too.
  for (const m of conversation.slice(question > 1 ? 2 : question + 1)) {
    const answer = m.role === 'assistant' && !m.talk ? answerOf(m.content) : '';
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
  const last = conversation && [...conversation].reverse().find((m) => m.role === 'assistant' && !m.talk);
  return last ? answerOf(last.content) : '';
}

const unquote = (s) => s.trim().replace(/^["'“‘<](.*)["'”’>]$/, '$1');

/**
 * Read the model's commands, one per line. Things can be named by number (#3), or by their words
 * ("drag Dog to Mammals") when a model forgets the numbers; places by two grid numbers. Anything
 * it can't follow is skipped. `elements` is the list of things (or just how many there are).
 */
function readCommands(reply, elements) {
  const list = Array.isArray(elements) ? elements : [];
  const count = Array.isArray(elements) ? elements.length : Number(elements) || 0;
  const actions = [];
  let look = false;
  const id = (n) => {
    const i = Number(n) - 1;
    return i >= 0 && i < count ? i : null;
  };
  const hashes = /#\d/.test(reply);
  const plain = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // A thing by its words: the same name, else one that starts with them, else one that holds them.
  const byName = (words) => {
    const want = plain(words);
    if (!want) return null;
    let best = null;
    list.forEach((e, i) => {
      const name = plain(e.name);
      if (!name) return;
      const score = name === want ? 3 : want.length >= 2 && name.startsWith(want) ? 2 : want.length >= 3 && name.includes(want) ? 1 : 0;
      if (score && (!best || score > best.score || (score === best.score && name.length < best.length))) best = { i, score, length: name.length };
    });
    return best ? best.i : null;
  };
  // "#3" is thing 3. A bare 3 is thing 3 too, unless the reply numbers things with # and a thing is called "3".
  // In quotes it is always a name: drag "8" means the card that says 8, never thing 8.
  const thing = (token) => {
    const bare = String(token || '').trim().replace(/^(?:the|thing|item|option|box|number)\s+/i, '');
    const quoted = /^["“‘']/.test(bare);
    const t = unquote(bare);
    let m;
    if ((m = t.match(/^#\s*(\d+)$/))) return id(m[1]);
    // "B" is the option labelled "B." or "(B)".
    if (/^[a-h]$/i.test(t)) {
      const lettered = list.findIndex((e) => new RegExp(`^\\s*\\(?${t}\\s*[.):]`, 'i').test(e.name));
      if (lettered >= 0) return lettered;
    }
    if (/^\d+$/.test(t)) {
      const named = list.findIndex((e) => plain(e.name) === t);
      if (named >= 0 && (hashes || quoted || id(t) === null)) return named;
      return quoted ? null : id(t);
    }
    return list.length ? byName(t) : null;
  };
  const pair = (s) => {
    const m = String(s).trim().match(/^#?\s*\(?\s*(\d+)\s*[,\s]\s*(\d+)\s*\)?$/);
    return m ? { x: +m[1], y: +m[2] } : null;
  };
  const skipped = []; // commands that named nothing it could find
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/[`*]/g, '').replace(/^\s*(?:[-•>]|\d+[.)])\s+/, '').trim();
    let m;
    const before = actions.length;
    if (/^look\b/i.test(line)) look = true;
    else if ((m = line.match(/^click\s+(.+)$/i))) {
      const rest = m[1].trim();
      const at = pair(rest);
      if (at) actions.push({ type: 'click', at });
      else {
        // "click 9 option "3/4"" still means click 9; "click Whale" means the thing called Whale.
        const lead = rest.match(/^#?\s*\d+(?=\s|$)/);
        const target = lead ? thing(lead[0]) : thing(rest);
        if (target !== null) actions.push({ type: 'click', target });
      }
    } else if (count && (m = line.match(/^type\s+#?(\d+)\s+(.+)$/i)) && id(m[1]) !== null) {
      // A model that copies the command's description back has nothing to type.
      if (!/\btext box\b|<text>/i.test(m[2])) actions.push({ type: 'type', target: id(m[1]), text: unquote(m[2]) });
    } else if ((m = line.match(/^type\s+(.+)$/i))) actions.push({ type: 'type', text: unquote(m[1]) });
    else if (count && (m = line.match(/^choose\s+#?(\d+)\s+(.+)$/i)) && id(m[1]) !== null) actions.push({ type: 'choose', target: id(m[1]), text: unquote(m[2]) });
    else if ((m = line.match(/^drag\s+(.+)$/i))) {
      const rest = m[1].trim();
      // Quoted names can hold the joining words themselves: drag "Back to school" to "Autumn".
      const named = rest.match(/^(["“].+?["”])\s+(?:on(?:to)?|to|into|in|at|->|→)\s+(["“].+?["”])$/i);
      const split = named ? [named[1], named[2]] : rest.split(/\s+(?:on(?:to)?|to|into|in|at|->|→)\s+/i);
      let from = null;
      let to = null;
      if (split.length === 2) {
        from = pair(split[0]) || thing(split[0]);
        to = pair(split[1]) || thing(split[1]);
      } else {
        const numbers = rest.replace(/[(),#]/g, ' ').trim().split(/\s+/);
        if (numbers.every((n) => /^\d+$/.test(n))) {
          // "drag #3 142 160 5 97 304": both things with where they are, copied from the list.
          if (numbers.length === 6) [from, to] = [thing(`#${numbers[0]}`), thing(`#${numbers[3]}`)];
          else if (numbers.length === 4) [from, to] = [{ x: +numbers[0], y: +numbers[1] }, { x: +numbers[2], y: +numbers[3] }];
          else if (numbers.length === 3) [from, to] = [thing(`#${numbers[0]}`), { x: +numbers[1], y: +numbers[2] }];
          else if (numbers.length === 2) [from, to] = [thing(rest.split(/\s+/)[0]), thing(rest.split(/\s+/)[1])];
        } else if (numbers.length === 2) [from, to] = [thing(numbers[0]), thing(numbers[1])];
      }
      // A place to drop into is never what gets dragged: the model wrote them the wrong way round.
      const isPlace = (t) => typeof t === 'number' && list[t] && (list[t].type === 'place' || (list[t].type === 'group' && list[t].w > 120));
      if (from !== null && to !== null && isPlace(from) && !isPlace(to) && typeof to === 'number') [from, to] = [to, from];
      if (from !== null && to !== null) {
        const action = { type: 'drag' };
        if (typeof from === 'number') action.from = from;
        else action.fromAt = from;
        if (typeof to === 'number') action.to = to;
        else action.toAt = to;
        actions.push(action);
      }
    } else if ((m = line.match(/^key\s+(enter|tab|down|up)\b/i))) actions.push({ type: 'key', key: m[1].toLowerCase() });
    if (actions.length === before && /^(?:click|type|choose|drag)\b/i.test(line)) skipped.push(line.slice(0, 120));
  }
  return { actions: actions.slice(0, 20), look, skipped };
}

/** A point on the 0–1000 grid of the capture, as a real screen pixel. */
function gridToScreen(rect, point) {
  const gx = Math.min(1000, Math.max(0, Number(point && point.x) || 0));
  const gy = Math.min(1000, Math.max(0, Number(point && point.y) || 0));
  return screen.dipToScreenPoint({ x: rect.x + (gx / 1000) * rect.width, y: rect.y + (gy / 1000) * rect.height });
}

async function clickAt(p) {
  await glide(p);
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
    // What the dropdown holds, so a longer answer ("The sky is blue") still picks the right entry.
    const held = await input.options(target, process.pid).catch(() => []);
    action.text = bestEntry(action.text, held.map((o) => o.name));
    await clickAt(target);
    await wait(350);
    // A list the page built itself shows its entries as things to click.
    const shown = (await frameElements(rect).catch(() => [])).filter((e) => ['listitem', 'menuitem', 'dataitem', 'treeitem'].includes(e.type));
    action.text = bestEntry(action.text, shown.map((e) => e.name));
    const wanted = simple(action.text);
    const entry = shown.find((e) => simple(e.name) === wanted);
    if (entry) await clickAt(entry);
    else {
      // A plain dropdown: typing the entry picks it, in browsers and most apps.
      await input.type(action.text.slice(0, 200));
      await wait(200);
      await input.key('enter');
    }
  } else if (action.type === 'key') {
    await input.key(action.key);
  } else if (action.type === 'drag') {
    const from = action.from != null ? elements[action.from] : gridToScreen(rect, action.fromAt);
    const to = action.to != null ? elements[action.to] : gridToScreen(rect, action.toAt);
    if (process.env.SAGE_DEBUG) console.log(`drag from ${from.x},${from.y} to ${to.x},${to.y}`);
    await dragBetween(from, to, check);
  } else if (action.type === 'slider') {
    // Click along the track, then arrow keys for the exact value.
    const k = (action.value - target.min) / (target.max - target.min || 1);
    const across = target.w >= target.h;
    await clickAt(across ? { x: target.x - target.w / 2 + k * target.w, y: target.y } : { x: target.x, y: target.y + target.h / 2 - k * target.h });
    await wait(200);
    let side = 0;
    for (let n = 0; n < 40; n++) {
      check();
      const now = (await frameElements(rect).catch(() => [])).find((e) => e.type === 'slider' && e.name === target.name);
      if (!now || Number(now.value) === action.value) break;
      const way = Number(now.value) < action.value ? 1 : -1;
      if (side && way !== side) break; // stepped past it: the slider has no such value
      side = way;
      await input.combo(way > 0 ? 'right' : 'left');
      await wait(60);
    }
  } else if (action.type === 'sort') {
    // One card at a time into its spot, looking again after each, since the rest shift along.
    const order = action.order.map((i) => elements[i]);
    for (let n = 0; n <= order.length; n++) {
      check();
      const now = await frameElements(rect).catch(() => []);
      const cards = order.map((c) => now.find((e) => e.type === c.type && e.name === c.name));
      if (cards.some((c) => !c)) break;
      const reach = (key) => Math.max(...cards.map((c) => c[key])) - Math.min(...cards.map((c) => c[key]));
      const along = reach('y') >= reach('x') ? 'y' : 'x';
      const slots = [...cards].sort((a, b) => a[along] - b[along]);
      const wrong = cards.findIndex((c, k) => c !== slots[k]);
      if (wrong < 0) break;
      const spot = slots[wrong];
      const nudge = Math.max(4, (along === 'y' ? spot.h : spot.w) * 0.35); // just before what is there
      await dragBetween(cards[wrong], { x: spot.x, y: spot.y, [along]: spot[along] - nudge }, check);
      await wait(350);
    }
  }
  await wait(350);
}

/** Whether a text has this name in it as whole words. */
function saysName(text, name) {
  const safe = String(name).trim().replace(/[.*+?^$()|[\]{}\\/]/g, '\\$&');
  return !!safe && new RegExp('(?<![\\p{L}\\p{N}])' + safe + '(?![\\p{L}\\p{N}])', 'iu').test(text);
}

/** The dropdown entry a piece of text means: the same words, or the one entry it names. */
function bestEntry(value, entries) {
  const want = simple(value);
  const same = entries.find((n) => simple(n) === want);
  if (same) return same;
  const said = entries.filter((n) => saysName(value, n));
  return said.length === 1 ? said[0] : value;
}

/** Press, travel smoothly and let go. The button always comes back up, even if the run is stopped halfway. */
async function dragBetween(from, to, check) {
  await glide(from);
  await wait(150);
  await input.down();
  try {
    await wait(120);
    // Pages only start a drag once the pointer has moved a little while held, and only
    // drop it where it was hovering: so nudge, travel smoothly, then settle before letting go.
    await input.move(from.x + 4, from.y + 4);
    await wait(120);
    const steps = 28;
    for (let step = 1; step <= steps; step++) {
      check();
      const t = step / steps;
      const k = t * t * (3 - 2 * t);
      await input.move(from.x + 4 + (to.x - from.x - 4) * k, from.y + 4 + (to.y - from.y - 4) * k);
      await wait(16);
    }
    await input.move(to.x + 1, to.y);
    await wait(90);
    await input.move(to.x, to.y);
    await wait(180);
  } finally {
    await input.up();
  }
}

/** Move the pointer smoothly to a point (real pixels), so it doesn't jump about the screen. */
async function glide(p) {
  const start = screen.dipToScreenPoint(screen.getCursorScreenPoint());
  const distance = Math.hypot(p.x - start.x, p.y - start.y);
  const steps = Math.min(14, Math.max(1, Math.round(distance / 60)));
  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    const k = t * t * (3 - 2 * t);
    await input.move(start.x + (p.x - start.x) * k, start.y + (p.y - start.y) * k);
    await wait(12);
  }
  await input.move(p.x, p.y);
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
  // During a run a click just passes through whatever is there: nothing needs to fade for it.
  if (steady.on) {
    const showing = ours.filter((win) => !steady.out.has(win));
    for (const win of showing) win.setIgnoreMouseEvents(true);
    try {
      return await fn();
    } finally {
      for (const win of showing) if (!win.isDestroyed()) win.setIgnoreMouseEvents(false);
    }
  }
  for (const win of ours) win.setIgnoreMouseEvents(true);
  if (ours.length) await Promise.all(ours.map((win) => fadeTo(win, 0, 180)));
  try {
    return await fn();
  } finally {
    for (const win of ours) {
      if (win.isDestroyed()) continue;
      win.setIgnoreMouseEvents(false);
      fadeTo(win, 1, 260);
    }
  }
}

const around = (p) => ({ x: p.x - 4, y: p.y - 4, width: 8, height: 8 });

/** Fill in: the model looks at the frame (and the controls in it) and enters the answer. */
// How the last answer went in (say "drag, drag, drag"), as a hint for the next question on the same page.
let lastFill = null;

// A tiny 3×5 font for the numbers drawn on the picture the model sees.
const GLYPHS = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111',
};

/**
 * The capture with faint grid lines every 100 (numbered along the top and left) and a small dark tag
 * with each thing's number beside it, so the model can tell what is where: which card is #4, and
 * where an empty box or a spot on a picture is on the grid.
 */
function markImage(image, rect, elements) {
  const { width: W, height: H } = image.getSize();
  const px = Buffer.from(image.toBitmap()); // BGRA
  const s = Math.max(2, Math.round(Math.max(W, H) / 520));
  const blend = (x, y, rgb, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = px[i] * (1 - a) + rgb[2] * a;
    px[i + 1] = px[i + 1] * (1 - a) + rgb[1] * a;
    px[i + 2] = px[i + 2] * (1 - a) + rgb[0] * a;
  };
  const tagSize = (str) => ({ w: str.length * 4 * s + s + 2, h: 5 * s + 2 * s });
  const tag = (str, x0, y0, background) => {
    const { w, h } = tagSize(str);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) blend(x0 + x, y0 + y, background, 0.82);
    [...str].forEach((ch, n) => {
      const glyph = GLYPHS[ch];
      if (!glyph) return;
      for (let gy = 0; gy < 5; gy++)
        for (let gx = 0; gx < 3; gx++)
          if (glyph[gy * 3 + gx] === '1')
            for (let dy = 0; dy < s; dy++)
              for (let dx = 0; dx < s; dx++) blend(x0 + 1 + s + n * 4 * s + gx * s + dx, y0 + s + gy * s + dy, [255, 255, 255], 1);
    });
  };
  // The grid, faint, numbered along the top and left edges.
  for (let g = 100; g < 1000; g += 100) {
    const x = Math.round((g / 1000) * W);
    const y = Math.round((g / 1000) * H);
    for (let yy = 0; yy < H; yy += 1) if (yy % 6 < 3) blend(x, yy, [0, 150, 255], 0.35);
    for (let xx = 0; xx < W; xx += 1) if (xx % 6 < 3) blend(xx, y, [0, 150, 255], 0.35);
    tag(String(g), x + 2, 1, [0, 90, 170]);
    tag(String(g), W - tagSize(String(g)).w - 1, y + 2, [0, 90, 170]); // on the right, where pages rarely put things
  }
  // Each thing's number, just above its top-left corner (long text needs none).
  const real = screen.dipToScreenRect(null, rect);
  const [kx, ky] = [W / real.width, H / real.height];
  elements.forEach((e, i) => {
    if (e.type === 'text' && e.name.length > 40) return;
    const str = String(i + 1);
    const { w, h } = tagSize(str);
    const left = (e.x - (e.w || 0) / 2 - real.x) * kx;
    const top = (e.y - (e.h || 0) / 2 - real.y) * ky;
    tag(str, Math.round(Math.min(W - w, Math.max(0, left - w + 3))), Math.round(Math.min(H - h, Math.max(0, top - h + 3))), [20, 20, 20]);
  });
  return nativeImage.createFromBitmap(px, { width: W, height: H });
}

/**
 * Empty places to drop things into, found in the picture: empty boxes (a border with nothing inside)
 * and blank gaps (a line with nothing on it). Pages rarely name these, so Windows can't list them,
 * but a drag-into-the-boxes question needs them. Returned as things in real screen pixels.
 */
function emptyPlaces(image, rect, elements) {
  const { width: W, height: H } = image.getSize();
  if (W * H > 3e6 || W < 40 || H < 40) return [];
  const px = image.toBitmap(); // BGRA
  const real = screen.dipToScreenRect(null, rect);
  const k = W / rect.width; // picture pixels per screen unit
  // The page's background: its most common colour.
  const counts = new Map();
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4;
      const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const bgKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const bg = [((bgKey >> 8) & 15) * 16 + 8, ((bgKey >> 4) & 15) * 16 + 8, (bgKey & 15) * 16 + 8];
  const ink = (x, y) => {
    const i = (y * W + x) * 4;
    return Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 70;
  };
  const inkShare = (x0, y0, x1, y1) => {
    [x0, y0, x1, y1] = [Math.max(0, Math.round(x0)), Math.max(0, Math.round(y0)), Math.min(W - 1, Math.round(x1)), Math.min(H - 1, Math.round(y1))];
    if (x1 < x0 || y1 < y0) return 1;
    let n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ink(x, y)) n++;
    return n / ((x1 - x0 + 1) * (y1 - y0 + 1));
  };
  // Horizontal lines, solid or dashed: long runs of ink with clear rows just above and below.
  const minLength = 34 * k;
  const maxLength = 420 * k;
  const gap = Math.max(6, Math.round(9 * k));
  const rows = [];
  for (let y = 2; y < H - 2; y++) {
    let start = -1;
    let last = -1;
    let n = 0;
    const close = () => {
      const length = last - start + 1;
      if (start < 0 || length < minLength || length > maxLength || n / length < 0.33) return;
      const off = Math.max(3, Math.round(3 * k));
      if (inkShare(start, y - off, last, y - off) > 0.25 || inkShare(start, y + off, last, y + off) > 0.25) return; // inside text or a picture
      rows.push({ y, x0: start, x1: last });
    };
    for (let x = 0; x < W; x++) {
      if (!ink(x, y)) continue;
      if (start >= 0 && x - last > gap) {
        close();
        start = -1;
      }
      if (start < 0) {
        start = x;
        n = 0;
      }
      last = x;
      n++;
    }
    close();
  }
  // Rows of the same line (a line 2 or 3 pixels thick) become one.
  const lines = [];
  for (const r of rows) {
    const line = lines.find((l) => r.y - l.y1 <= 1 && Math.abs(l.x0 - r.x0) <= 3 * k && Math.abs(l.x1 - r.x1) <= 3 * k);
    if (line) line.y1 = r.y;
    else lines.push({ y0: r.y, y1: r.y, x0: r.x0, x1: r.x1 });
  }
  const thin = lines.filter((l) => l.y1 - l.y0 + 1 <= 4 * k);
  const places = [];
  const used = new Set();
  const m = 3 * k;
  // An upright edge somewhere in a band of columns (rounded corners put it a little past the line's end).
  const upright = (xFrom, xTo, y0, y1) => {
    let best = 0;
    for (let x = Math.max(0, Math.round(xFrom)); x <= Math.min(W - 1, Math.round(xTo)); x++) best = Math.max(best, inkShare(x, y0, x, y1));
    return best;
  };
  // Empty boxes: a line with another above it, and nothing between them.
  for (const bottom of thin) {
    let best = null;
    for (const top of thin) {
      if (top === bottom || used.has(top) || top.y1 >= bottom.y0) continue;
      const height = bottom.y0 - top.y1;
      if (height < 16 * k || height > 170 * k) continue;
      const overlap = Math.min(top.x1, bottom.x1) - Math.max(top.x0, bottom.x0);
      if (overlap < 0.8 * (top.x1 - top.x0) || overlap < 0.8 * (bottom.x1 - bottom.x0)) continue;
      if (!best || top.y1 > best.y1) best = top;
    }
    if (!best) continue;
    const x0 = Math.max(best.x0, bottom.x0);
    const x1 = Math.min(best.x1, bottom.x1);
    if (inkShare(x0 + m, best.y1 + m, x1 - m, bottom.y0 - m) > 0.02) continue; // something is in it
    // A box has sides; two unrelated lines one above the other don't.
    const midTop = best.y1 + (bottom.y0 - best.y1) / 4;
    const midBottom = bottom.y0 - (bottom.y0 - best.y1) / 4;
    if (upright(x0 - 12 * k, x0 + 2 * k, midTop, midBottom) < 0.25 || upright(x1 - 2 * k, x1 + 12 * k, midTop, midBottom) < 0.25) continue;
    used.add(best).add(bottom);
    places.push({ name: 'empty box', x: (x0 + x1) / 2, y: (best.y1 + bottom.y0) / 2, w: x1 - x0, h: bottom.y0 - best.y1 });
  }
  // Blank gaps: a line on its own (no sides going up or down from its ends), with nothing on it.
  for (const line of thin) {
    if (used.has(line)) continue;
    // The top or bottom of a box with something in it has its partner line across from it.
    const partner = thin.some((other) => {
      if (other === line) return false;
      const apart = Math.abs(other.y0 - line.y0);
      const overlap = Math.min(other.x1, line.x1) - Math.max(other.x0, line.x0);
      return apart >= 12 * k && apart <= 170 * k && overlap >= 0.8 * (line.x1 - line.x0) && overlap >= 0.8 * (other.x1 - other.x0);
    });
    if (partner) continue;
    // The top or bottom of a box (a button, a card, a text box) has sides going down or up from its
    // ends, touching the line; words beside a gap stand clear of it.
    // Follow the ink joined to one end of the line, in a small square round that end.
    const reach = (xEnd) => {
      const [left, right] = [Math.max(0, Math.round(xEnd - 12 * k)), Math.min(W - 1, Math.round(xEnd + 12 * k))];
      const [top, bottom] = [Math.max(0, Math.round(line.y0 - 16 * k)), Math.min(H - 1, Math.round(line.y1 + 16 * k))];
      const seen = new Set();
      const queue = [];
      for (let y = line.y0; y <= line.y1; y++) {
        for (let x = Math.max(left, Math.round(xEnd - 2 * k)); x <= Math.min(right, Math.round(xEnd + 2 * k)); x++) {
          if (ink(x, y)) {
            seen.add(y * W + x);
            queue.push([x, y]);
          }
        }
      }
      let [up, down] = [0, 0];
      while (queue.length && seen.size < 4000) {
        const [x, y] = queue.pop();
        up = Math.max(up, line.y0 - y);
        down = Math.max(down, y - line.y1);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const [nx, ny] = [x + dx, y + dy];
            if (nx < left || nx > right || ny < top || ny > bottom || seen.has(ny * W + nx) || !ink(nx, ny)) continue;
            seen.add(ny * W + nx);
            queue.push([nx, ny]);
          }
        }
      }
      return Math.max(up, down);
    };
    if (reach(line.x0) >= 5 * k || reach(line.x1) >= 5 * k) continue;
    if (inkShare(line.x0 + m, line.y0 - 22 * k, line.x1 - m, line.y0 - m) > 0.02) continue;
    places.push({ name: 'empty gap', x: (line.x0 + line.x1) / 2, y: line.y0 - 12 * k, w: line.x1 - line.x0, h: 20 * k, line });
  }
  // As things in real pixels, leaving out any that are already a listed thing (a text box, a named box),
  // or the edge of one.
  const [sx, sy] = [W / real.width, H / real.height];
  const out = [];
  for (const p of places) {
    const thing = { type: 'place', name: p.name, value: '', state: '', x: Math.round(real.x + p.x / sx), y: Math.round(real.y + p.y / sy), w: Math.round(p.w / sx), h: Math.round(p.h / sy) };
    const listed = elements.filter((e) => e.w && e.h && e.type !== 'text');
    const inside = listed.some((e) => Math.abs(thing.x - e.x) < e.w / 2 && Math.abs(thing.y - e.y) < e.h / 2);
    const edge =
      p.line &&
      listed.some((e) => {
        const [lx0, lx1, ly] = [real.x + p.line.x0 / sx, real.x + p.line.x1 / sx, real.y + p.line.y0 / sy];
        const overlap = Math.min(lx1, e.x + e.w / 2) - Math.max(lx0, e.x - e.w / 2);
        return overlap > 0.5 * (lx1 - lx0) && ly >= e.y - e.h / 2 - 6 && ly <= e.y + e.h / 2 + 6;
      });
    const twice = out.some((o) => Math.hypot(o.x - thing.x, o.y - thing.y) < 14 * k);
    const holds = p.name === 'empty box' && elements.some((e) => Math.abs(e.x - thing.x) < thing.w / 2 && Math.abs(e.y - thing.y) < thing.h / 2);
    if (!inside && !edge && !twice && !holds) out.push(thing);
  }
  // Numbered in reading order (row by row, left to right): "empty box 1", "empty box 2"…
  const row = 24 / sy;
  out.sort((a, b) => Math.round(a.y / row) - Math.round(b.y / row) || a.x - b.x);
  const numbered = {};
  for (const p of out) {
    numbered[p.name] = (numbered[p.name] || 0) + 1;
    p.name = `${p.name} ${numbered[p.name]}`;
  }
  return out.slice(0, 16);
}

/**
 * Solid patches of colour (squares, circles, tiles with no words), which Windows can't list, as things
 * to click. Not on a page with text boxes, and not on a busy picture.
 */
function colourShapes(image, rect, elements) {
  const { width: W, height: H } = image.getSize();
  if (W * H > 3e6 || W < 40 || H < 40 || elements.some((e) => TYPING.has(e.type))) return [];
  const px = image.toBitmap(); // BGRA
  const real = screen.dipToScreenRect(null, rect);
  const k = W / rect.width;
  const cell = Math.max(2, Math.round(3 * k));
  const [cols, rows] = [Math.floor(W / cell), Math.floor(H / cell)];
  const NAMES = ['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
  const hueOfPixel = (b, g, r) => {
    const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
    if (max < 70 || max - min < 70) return 0;
    const h = max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    const deg = h * 60;
    return deg < 15 || deg >= 340 ? 1 : deg < 45 ? 2 : deg < 70 ? 3 : deg < 170 ? 4 : deg < 260 ? 5 : deg < 300 ? 6 : 7;
  };
  const grid = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = ((y * cell + (cell >> 1)) * W + x * cell + (cell >> 1)) * 4;
      grid[y * cols + x] = hueOfPixel(px[i], px[i + 1], px[i + 2]);
    }
  }
  const seen = new Uint8Array(cols * rows);
  const found = [];
  for (let start = 0; start < grid.length; start++) {
    if (!grid[start] || seen[start]) continue;
    const colour = grid[start];
    const stack = [start];
    seen[start] = 1;
    let [n, x0, y0, x1, y1] = [0, cols, rows, 0, 0];
    while (stack.length) {
      const at = stack.pop();
      const [x, y] = [at % cols, Math.floor(at / cols)];
      n++;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      for (const next of [x > 0 ? at - 1 : -1, x < cols - 1 ? at + 1 : -1, y > 0 ? at - cols : -1, y < rows - 1 ? at + cols : -1]) {
        if (next >= 0 && !seen[next] && grid[next] === colour) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    const [bw, bh] = [(x1 - x0 + 1) * cell, (y1 - y0 + 1) * cell];
    if (n * cell * cell < 500 * k * k || Math.min(bw, bh) < 16 * k || n * cell * cell < 0.5 * bw * bh) continue;
    found.push({ colour: NAMES[colour], x: x0 * cell + bw / 2, y: y0 * cell + bh / 2, w: bw, h: bh });
  }
  if (found.length > 12) return [];
  const [sx, sy] = [W / real.width, H / real.height];
  const listed = elements.filter((e) => e.w && e.h && e.type !== 'text');
  const out = [];
  const counts = {};
  found.sort((a, b) => Math.round(a.y / (24 * k)) - Math.round(b.y / (24 * k)) || a.x - b.x);
  for (const p of found) {
    const thing = { type: 'shape', name: '', value: '', state: '', x: Math.round(real.x + p.x / sx), y: Math.round(real.y + p.y / sy), w: Math.round(p.w / sx), h: Math.round(p.h / sy) };
    if (listed.some((e) => Math.abs(thing.x - e.x) < e.w / 2 && Math.abs(thing.y - e.y) < e.h / 2)) continue;
    counts[p.colour] = (counts[p.colour] || 0) + 1;
    thing.name = counts[p.colour] > 1 ? `${p.colour} shape ${counts[p.colour]}` : `${p.colour} shape`;
    out.push(thing);
  }
  return out;
}

/** After a drag the page moves things about: find each thing again by its name and kind. */
async function relocate(elements, rect, actions = []) {
  const fresh = await frameElements(rect).catch(() => null);
  if (!fresh || !fresh.length) return;
  const before = elements.map((e) => ({ x: e.x, y: e.y }));
  for (const e of elements) {
    let best = null;
    for (const f of fresh) {
      if (f.type !== e.type || f.name !== e.name) continue;
      const d = Math.hypot(f.x - e.x, f.y - e.y);
      if (!best || d < best.d) best = { f, d };
    }
    if (best) Object.assign(e, { x: best.f.x, y: best.f.y, w: best.f.w, h: best.f.h });
  }
  // Empty boxes and gaps aren't in Windows' list: they move with the words beside them.
  const carried = new Set(actions.filter((a) => a.type === 'drag').map((a) => a.from));
  elements.forEach((e, i) => {
    if (e.type !== 'place') return;
    let anchor = null;
    elements.forEach((o, j) => {
      if (o.type === 'place' || o.type === 'shape' || carried.has(j)) return;
      const d = Math.hypot(before[j].x - before[i].x, before[j].y - before[i].y);
      if (!anchor || d < anchor.d) anchor = { j, d };
    });
    if (!anchor) return;
    e.x += elements[anchor.j].x - before[anchor.j].x;
    e.y += elements[anchor.j].y - before[anchor.j].y;
  });
}

/** What an action did, in words the model can read back. */
function actionWords(action, rect, elements) {
  const thing = (i) => `#${i + 1} "${text(elements[i].name, 40)}"`;
  const at = (p) => `${p.x},${p.y}`;
  switch (action.type) {
    case 'click':
      return action.target != null ? `clicked ${thing(action.target)}` : `clicked at ${at(action.at)}`;
    case 'type':
      return `typed "${action.text}"${action.target != null ? ` into ${thing(action.target)}` : ''}`;
    case 'choose':
      return `chose "${action.text}" in ${thing(action.target)}`;
    case 'drag':
      return `dragged ${action.from != null ? thing(action.from) : at(action.fromAt)} to ${action.to != null ? thing(action.to) : at(action.toAt)}`;
    case 'slider':
      return `set ${thing(action.target)} to ${action.value}`;
    case 'sort':
      return `moved the cards into the order ${action.order.map((i) => `"${text(elements[i].name, 30)}"`).join(', ')}`;
    default:
      return `pressed ${action.key}`;
  }
}

/** A short reply from the model. One that rambles on is cut off, and what it said up to there is used. */
async function shortReply({ messages, signal, temperature, most = 1500 }) {
  const providerId = settings.provider;
  const turn = new AbortController();
  const stop = () => turn.abort();
  if (signal) {
    if (signal.aborted) turn.abort();
    signal.addEventListener('abort', stop, { once: true });
  }
  let said = '';
  let cut = false;
  try {
    return await chat(providerId, {
      model: modelFor(providerId),
      apiKey: getKey(providerId),
      baseUrl: baseUrlFor(providerId),
      messages,
      temperature,
      signal: turn.signal,
      onChunk: (piece) => {
        said += piece;
        if (said.length > most && !cut) {
          cut = true;
          turn.abort();
        }
      },
    });
  } catch (error) {
    if (!cut || (signal && signal.aborted)) throw error;
    // The last line may be half written, and a model stuck in a loop repeats the rest.
    const lines = said.split('\n');
    if (lines.length > 1) lines.pop();
    return [...new Set(lines)].join('\n');
  } finally {
    if (signal) signal.removeEventListener('abort', stop);
  }
}

const PICKABLE = new Set(['radiobutton', 'checkbox', 'listitem', 'button', 'splitbutton', 'menuitem', 'tabitem', 'treeitem', 'dataitem', 'custom', 'image', 'text']);
const UNTYPED = new Set(['button', 'splitbutton', 'radiobutton', 'checkbox', 'hyperlink', 'tabitem', 'menuitem']);
const isOn = (e) => /^(?:checked|selected)$/.test(e.state || '');
const readingOrder = (list) => [...list].sort((a, b) => (Math.abs(a.e.y - b.e.y) < 14 ? a.e.x - b.e.x : a.e.y - b.e.y));

/**
 * What the answer already spells out, as moves: boxes to fill, options to pick, pairs to match, words
 * to build a sentence from, cards to put in order, a slider's value, a coloured shape. Only when each
 * part is exactly one thing on screen; anything less (null) is left to the model.
 */
function clearPlan(answer, elements) {
  const plain = toPlain(answer).trim();
  const lines = plain.split('\n').map((l) => l.trim().replace(/^[-•*]\s+/, '')).filter(Boolean);
  if (!lines.length) return null;
  const indexed = elements.map((e, i) => ({ e, i }));
  const allFields = readingOrder(indexed.filter(({ e }) => TYPING.has(e.type)));
  const asked = allFields.filter(({ e }) => !/\b(?:search|find|filter|url|address)\b/i.test(e.name));
  const fields = asked.length ? asked : allFields;
  const words = elements.filter((e) => e.type === 'text').map((e) => e.name).join(' ');
  const moving = /\b(?:drag|drop|order|arrange|sort|rank|sequence)\b/i.test(words);
  const one = (hits) => {
    const best = hits.length > 1 ? hits.filter(({ e }) => e.type !== 'text') : hits;
    return best.length === 1 ? best[0].i : null;
  };
  const named = (part, allowed = () => true) => {
    const want = simple(part);
    return want ? one(indexed.filter(({ e }) => allowed(e) && simple(e.name) === want)) : null;
  };
  const tick = (e) => e.type === 'radiobutton' || e.type === 'checkbox';
  const card = (e) => e.type !== 'place' && e.type !== 'shape' && e.name.length <= 60;
  const distinct = (list) => list.length > 0 && list.every((i) => i !== null) && new Set(list).size === list.length;
  const splitUp = (l) => l.split(/\s*(?:[,;]|\band\b)\s*/i).filter(Boolean);
  const pairOf = (l) => {
    const arrow = l.split(/\s*(?:→|->|=>|⇒)\s*/);
    if (arrow.length === 2) return arrow;
    const colon = l.split(/\s*:\s*/);
    return colon.length === 2 ? colon : null;
  };
  const pairs = lines.map(pairOf);
  const pickMoves = (picks) => {
    const moves = picks.filter((i) => !isOn(elements[i])).map((i) => ({ type: 'click', target: i, on: true }));
    // Ticks left over from an earlier answer come off.
    for (const { e, i } of indexed) if (e.state === 'checked' && !picks.includes(i)) moves.push({ type: 'click', target: i, on: false });
    return moves;
  };

  // Plain words count as an option only when they sit in a row or column with others like them.
  // The question on its own, however closely the answer repeats it, is not something to click.
  const shortTexts = elements.filter((e) => e.type === 'text' && e.name.length <= 40);
  const inSet = (e) =>
    shortTexts.some(
      (o) => o !== e && Math.abs((o.h || 0) - (e.h || 0)) <= 8 && (Math.abs(o.y - e.y) < 14 || Math.abs(o.x - (o.w || 0) / 2 - (e.x - (e.w || 0) / 2)) < 14),
    );
  const hasTicks = elements.some(tick);
  const zones = elements.filter((e) => e.type === 'group' && e.name && e.name.length <= 40);
  const inZone = (e) => zones.some((z) => z !== e && Math.abs(e.x - z.x) <= (z.w || 0) / 2 && Math.abs(e.y - z.y) <= (z.h || 0) / 2);
  const looseCard = (e) => zones.length >= 2 && !inZone(e);
  const pickable = (e) => {
    if (!PICKABLE.has(e.type)) return false;
    if (moving || hasTicks) return tick(e);
    if (e.type === 'text') return !allFields.length && !looseCard(e) && e.name.length <= 40 && inSet(e);
    return true;
  };
  const optionFor = (part) => {
    const direct = named(part, pickable);
    if (direct !== null) return direct;
    const letter = part.match(/^\(?([a-h])\)?[.):]?$/i);
    if (letter) return one(indexed.filter(({ e }) => pickable(e) && new RegExp('^\\s*\\(?' + letter[1] + '\\s*[.):]', 'i').test(e.name)));
    const body = (t) => simple(t.replace(/^\s*\(?[a-h][.):]\s+/i, ''));
    const want = body(part);
    return want ? one(indexed.filter(({ e }) => pickable(e) && body(e.name) === want)) : null;
  };

  // Options: each line of the answer is one thing to pick.
  const parts = lines.length === 1 && /[,;]|\band\b/i.test(lines[0]) && optionFor(lines[0]) === null ? splitUp(lines[0]) : lines;
  const picks = parts.map(optionFor);
  if (distinct(picks) && (!allFields.length || picks.every((i) => tick(elements[i])))) return pickMoves(picks);

  // The same options under each question ("True / False" three times): one answer per group, in order.
  const ticks = readingOrder(indexed.filter(({ e }) => tick(e)));
  const tokens = lines.length > 1 ? lines : lines[0].split(/[\s,;]+/).filter(Boolean);
  const size = ticks.length / tokens.length;
  if (tokens.length >= 2 && size >= 2 && Number.isInteger(size)) {
    const wordOf = (t) => simple(t.replace(/^\(?\d+[.)]\s*/, '').split(/[:→]/).pop());
    const chosen = tokens.map((t, n) => {
      const want = wordOf(t);
      const hits = ticks.slice(n * size, (n + 1) * size).filter(({ e }) => want && (simple(e.name) === want || simple(e.name).endsWith(want)));
      return hits.length === 1 ? hits[0].i : null;
    });
    if (distinct(chosen)) return pickMoves(chosen);
  }

  // Boxes and dropdowns: by their labels, or in order.
  if (fields.length) {
    const fill = ({ e, i }, value) => {
      if (e.type === 'combobox') return { type: 'choose', target: i, text: value };
      if (e.type === 'spinner') {
        const number = String(value).match(/-?\d+(?:[.,]\d+)?/);
        return { type: 'type', target: i, text: number ? number[0] : value };
      }
      return { type: 'type', target: i, text: value };
    };
    if (pairs.every(Boolean)) {
      const byLabel = pairs.map(([label]) => {
        const want = simple(label);
        const own = fields.find(({ e }) => simple(e.name) === want);
        if (own) return own;
        const tag = named(label, (e) => e.type === 'text');
        if (tag === null) return null;
        const beside = fields.filter(({ e }) => Math.abs(e.y - elements[tag].y) < 16 && e.x > elements[tag].x);
        return beside.length ? beside.reduce((n, f) => (f.e.x < n.e.x ? f : n)) : null;
      });
      if (byLabel.every(Boolean) && new Set(byLabel).size === byLabel.length) return byLabel.map((field, n) => fill(field, pairs[n][1]));
    }
    const values = lines.length === fields.length ? lines : lines.length === 1 && splitUp(lines[0]).length === fields.length ? splitUp(lines[0]) : null;
    if (values) return fields.map((field, n) => fill(field, values[n].replace(/^\(?\d+[.)]\s+/, '')));
    // One letter to a box.
    const letters = [...plain].filter((c) => /[\p{L}\p{N}]/u.test(c));
    if (fields.length > 1 && letters.length === fields.length && fields.every(({ e }) => e.type === 'edit' && (e.w || 99) <= 60)) {
      return fields.map((field, n) => fill(field, letters[n]));
    }
    return null;
  }

  // Pairs: a tick where a row meets a column, two buttons to click in turn, or a card to drag.
  if (pairs.every(Boolean)) {
    const moves = [];
    const dragged = [];
    let failed = false;
    for (const [left, right] of pairs) {
      const [wantA, wantB] = [simple(left), simple(right)];
      let box = one(indexed.filter(({ e }) => tick(e) && simple(e.name).includes(wantA) && simple(e.name).includes(wantB)));
      let [from, to] = [named(left, (e) => !tick(e) && card(e)), named(right, (e) => !tick(e))];
      // "Mammals: Dog" names the box first; the card is what moves.
      const zone = (i) => elements[i].type === 'group' || elements[i].type === 'place';
      if (from !== null && to !== null && zone(from) && !zone(to)) [from, to] = [to, from];
      if (box === null && from !== null && to !== null) {
        box = one(indexed.filter(({ e }) => tick(e) && Math.abs(e.y - elements[from].y) < 16 && Math.abs(e.x - elements[to].x) < 30));
      }
      if (box !== null) {
        if (!isOn(elements[box])) moves.push({ type: 'click', target: box, on: true });
      } else if (from === null || to === null || from === to) {
        failed = true;
        break;
      } else if (['button', 'splitbutton', 'listitem'].includes(elements[from].type) && ['button', 'splitbutton', 'listitem'].includes(elements[to].type)) {
        moves.push({ type: 'click', target: from }, { type: 'click', target: to });
      } else {
        dragged.push(from);
        moves.push({ type: 'drag', from, to });
      }
    }
    if (!failed && (!dragged.length || distinct(dragged))) return moves;
  }

  // An order: into one empty box each, or by moving the cards along their list.
  const places = indexed.filter(({ e }) => e.type === 'place');
  const numbered = lines.map((l) => l.match(/^\(?(\d+)[.)]\s*(.+)$/));
  const chain = lines.length === 1 ? lines[0].split(/\s*(?:→|->|=>|⇒|,)\s*/).filter(Boolean) : [];
  const items = numbered.every((m, n) => m && Number(m[1]) === n + 1)
    ? numbered.map((m) => m[2])
    : chain.length > 1 && (moving || /→|->|=>|⇒/.test(lines[0]))
      ? chain
      : moving && lines.length > 1
        ? lines
        : moving && lines.length === 1 && lines[0].split(/\s+/).length > 1
          ? lines[0].split(/\s+/)
          : null;
  if (items && items.length > 1) {
    const cards = items.map((t) => named(t, card));
    if (distinct(cards)) {
      if (places.length === cards.length) return cards.map((from, n) => ({ type: 'drag', from, to: places[n].i }));
      const spread = (k) => Math.max(...cards.map((i) => elements[i][k])) - Math.min(...cards.map((i) => elements[i][k]));
      const intoBoxes = /\b(?:into|onto)\b.*\b(?:box|boxes|slot|slots|gap|gaps|space|spaces|blank|blanks)\b/i.test(words);
      if (!places.length && !intoBoxes && (spread('x') <= 14 || spread('y') <= 14)) return [{ type: 'sort', order: cards }];
    }
  }

  // A sentence with gaps: the cards it uses, in the order it uses them, one to each gap.
  const mention = (name) => {
    const safe = name.trim().replace(/[.*+?^$()|[\]{}\\/]/g, '\\$&');
    const m = safe ? new RegExp('(?<![\\p{L}\\p{N}])' + safe + '(?![\\p{L}\\p{N}])', 'iu').exec(plain.replace(/\n/g, ' ')) : null;
    return m ? m.index : -1;
  };
  if (places.length) {
    const loose = indexed.filter(({ e }) => e.type !== 'place' && e.type !== 'shape' && e.name.length <= 40 && !places.some((p) => Math.abs(p.e.y - e.y) < 18));
    const used = loose.map((c) => ({ ...c, at: mention(c.e.name) })).filter((c) => c.at >= 0).sort((p, q) => p.at - q.at);
    if (used.length === places.length) return used.map((c, n) => ({ type: 'drag', from: c.i, to: places[n].i }));
  }

  // Word tiles: click them in the order of the sentence.
  if (lines.length === 1) {
    const sentence = lines[0].replace(/[.!?,;:]+/g, ' ').trim().split(/\s+/);
    if (sentence.length >= 2) {
      const free = indexed.filter(({ e }) => ['button', 'splitbutton', 'listitem', 'custom'].includes(e.type) && e.name.length <= 24);
      const tiles = [];
      for (const word of sentence) {
        const tile = free.find(({ e, i }) => simple(e.name) === simple(word) && !tiles.includes(i));
        if (tile) tiles.push(tile.i);
      }
      if (tiles.length === sentence.length) return tiles.map((target) => ({ type: 'click', target, moved: true }));
    }
  }

  // One slider and one number.
  const sliders = indexed.filter(({ e }) => e.type === 'slider' && e.max != null);
  if (sliders.length === 1) {
    const numbers = lines.join(' ').match(/-?\d+(?:\.\d+)?/g) || [];
    const value = Number(numbers[0]);
    if (numbers.length === 1 && value >= sliders[0].e.min && value <= sliders[0].e.max) return [{ type: 'slider', target: sliders[0].i, value }];
  }

  // One switch, and "on" or "off".
  const switches = indexed.filter(({ e }) => /^(?:not )?checked$/.test(e.state || ''));
  if (switches.length === 1) {
    const wantOn = /\b(?:off|no|false)\b/i.test(plain) ? false : /\b(?:on|yes|true)\b/i.test(plain) ? true : null;
    if (wantOn !== null) return isOn(switches[0].e) === wantOn ? [] : [{ type: 'click', target: switches[0].i, on: wantOn }];
  }

  // "The green square": the one shape of that colour.
  const colours = [...new Set(lines.join(' ').toLowerCase().match(/\b(?:red|orange|yellow|green|blue|purple|pink)\b/g) || [])];
  if (colours.length === 1) {
    const shape = one(indexed.filter(({ e }) => e.type === 'shape' && e.name.startsWith(colours[0])));
    if (shape !== null) return [{ type: 'click', target: shape }];
  }

  // A longer answer that names some of the options ("The answer is Paris").
  if (!moving) {
    const options = indexed.filter(({ e }) => pickable(e) && simple(e.name).length >= 2);
    const named2 = options.filter(({ e }) => mention(e.name.replace(/^\s*\(?[a-h][.):]\s+/i, '')) >= 0).map(({ i }) => i);
    if (options.length >= 2 && named2.length && named2.length < options.length) return pickMoves(named2);
  }
  return null;
}

// ---------- boxes the page draws itself ----------
// Maths and logic sites draw their own tiles and slots, which Windows often can't name or even list.
// They are found in the picture, read, and filled in whichever way the page turns out to work.

/** A value in a form that can be compared: "−23/2", "\frac{23}{2}" and "23 over 2" read the same. */
function cleanValue(raw) {
  let t = String(raw == null ? '' : raw).replace(/[​-‍⁠-⁤﻿$]/g, '').trim();
  const tex = t.match(/([-−])?\s*\\[dt]?frac\s*\{\s*([^{}]*?)\s*\}\s*\{\s*([^{}]*?)\s*\}/);
  if (tex) return `${tex[1] ? '-' : ''}${tex[2]}/${tex[3]}`;
  const vulgar = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };
  t = t
    .replace(/\\(?:left|right|,|;|!)/g, '')
    .replace(/\\times|\\cdot/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/[−–—‒]/g, '-')
    .replace(/[⁄∕]/g, '/')
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (c) => vulgar[c])
    .replace(/(\d)\s+over\s+(\d)/gi, '$1/$2')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(?:minus|negative)$/i.test(t)) return '-';
  if (/^plus$/i.test(t)) return '+';
  if (/^times$/i.test(t)) return '×';
  // Maths markup can be read out twice: "12 12".
  const words = t.split(' ');
  if (words.length === 2 && words[0] === words[1]) return words[0];
  return t;
}

/** What a tile says. A fraction drawn as two stacked numbers is read as "23 2". */
function tileValue(raw) {
  const t = cleanValue(raw);
  const stacked = t.match(/^(-?\d+) (\d+)$/);
  return stacked ? `${stacked[1]}/${stacked[2]}` : t;
}

function numberIn(raw) {
  const s = cleanValue(raw).replace(/\s/g, '').replace(/^\+(?=\d)/, '');
  if (/^-?\d*\.?\d+$/.test(s)) return Number(s);
  const m = s.match(/^(-?\d+)\/(\d+)$/);
  return m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
}

function sameValue(a, b) {
  const [x, y] = [cleanValue(a).toLowerCase().replace(/\s/g, ''), cleanValue(b).toLowerCase().replace(/\s/g, '')];
  if (!x || !y) return false;
  if (x === y) return true;
  const [p, q] = [numberIn(x), numberIn(y)];
  return p !== null && q !== null && Math.abs(p - q) < 1e-9;
}

/** An answer as separate pieces: numbers and fractions, words, and signs. */
function mathTokens(raw) {
  const flat = String(raw || '')
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/[−–—‒]/g, '-')
    .replace(/\\(?:left|right|,|;|!)/g, '')
    .replace(/[$\\{}()]/g, ' ');
  return (flat.match(/\d+(?:\.\d+)?(?:\s*\/\s*\d+)?|\p{L}+|[=+\-×÷*<>≤≥]/gu) || []).map((t) => t.replace(/\s/g, ''));
}

/** Line an answer's pieces up with a row of text and boxes: what is left over goes in the boxes. */
function alignParts(tokens, sequence) {
  const count = sequence.filter((s) => s.slot != null).length;
  const attempt = (list) => {
    const parts = [];
    let p = 0;
    for (let s = 0; s < sequence.length; s++) {
      const item = sequence[s];
      if (item.lit != null) {
        if (p < list.length && sameValue(list[p], item.lit)) p++;
        continue;
      }
      const next = sequence[s + 1];
      // "y = x + 3": nothing written before the x means 1.
      if (next && next.lit != null && /^\p{L}$/u.test(next.lit) && p < list.length && sameValue(list[p], next.lit)) {
        parts.push('1');
        continue;
      }
      if (p >= list.length) return null;
      parts.push(list[p++]);
    }
    return p === list.length && parts.length === count ? parts : null;
  };
  const signed = [];
  tokens.forEach((t, n) => {
    const before = tokens[n - 1];
    if (/^[-+]$/.test(before || '') && /^\d/.test(t)) signed[signed.length - 1] = before === '-' ? `-${t}` : t;
    else signed.push(t);
  });
  // A minus straight after "=" belongs to its number.
  const leading = [];
  tokens.forEach((t, n) => {
    const before = tokens[n - 1];
    if (before === '-' && /^\d/.test(t) && (n === 1 || /^[=+\-×÷*<>≤≥]$/.test(tokens[n - 2]))) leading[leading.length - 1] = `-${t}`;
    else leading.push(t);
  });
  return attempt(leading) || attempt(tokens) || attempt(signed);
}

/**
 * Boxes in the picture, bordered or just tinted, whether something is written in them or not. Each is
 * a patch of one colour shut off from the page, in real screen pixels, in reading order.
 */
function pictureBoxes(image, rect) {
  const { width: W, height: H } = image.getSize();
  if (W * H > 4e6 || W < 40 || H < 40) return [];
  const px = image.toBitmap();
  const real = screen.dipToScreenRect(null, rect);
  const k = W / rect.width;
  const step = Math.max(1, Math.floor(k));
  const [cols, rows] = [Math.floor(W / step), Math.floor(H / step)];
  const label = new Int32Array(cols * rows).fill(-1);
  const stack = new Int32Array(cols * rows);
  const at = (c, r) => (r * step * W + c * step) * 4;
  const patches = [];
  let page = null;
  let id = 0;
  for (let start = 0; start < label.length; start++) {
    if (label[start] >= 0) continue;
    const seed = at(start % cols, Math.floor(start / cols));
    const [b, g, r] = [px[seed], px[seed + 1], px[seed + 2]];
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    let [n, x0, y0, x1, y1] = [0, cols, rows, 0, 0];
    while (top) {
      const cell = stack[--top];
      const [x, y] = [cell % cols, Math.floor(cell / cols)];
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const next of [x > 0 ? cell - 1 : -1, x < cols - 1 ? cell + 1 : -1, y > 0 ? cell - cols : -1, y < rows - 1 ? cell + cols : -1]) {
        if (next < 0 || label[next] >= 0) continue;
        const i = at(next % cols, Math.floor(next / cols));
        if (Math.abs(px[i] - b) + Math.abs(px[i + 1] - g) + Math.abs(px[i + 2] - r) > 14) continue;
        label[next] = id;
        stack[top++] = next;
      }
    }
    const edge = x0 === 0 || y0 === 0 || x1 === cols - 1 || y1 === rows - 1;
    if (edge && (!page || n > page.n)) page = { n, b, g, r };
    const [bw, bh] = [(x1 - x0 + 1) * step, (y1 - y0 + 1) * step];
    if (!edge && bw >= 26 * k && bh >= 18 * k && bw <= 420 * k && bh <= 170 * k && bw / bh <= 9 && n * step * step >= 0.55 * bw * bh) {
      patches.push({ id, n, x0, y0, x1, y1, b, g, r });
    }
    id++;
  }
  const inside = (o, p) => o !== p && o.x0 >= p.x0 && o.x1 <= p.x1 && o.y0 >= p.y0 && o.y1 <= p.y1;
  const [sx, sy] = [W / real.width, H / real.height];
  const out = [];
  for (const p of patches) {
    if (patches.filter((o) => inside(o, p)).length >= 2) continue; // a panel holding tiles
    const [mx, my] = [Math.ceil((p.x1 - p.x0 + 1) * 0.12), Math.ceil((p.y1 - p.y0 + 1) * 0.12)];
    let [holes, cells] = [0, 0];
    for (let y = p.y0 + my; y <= p.y1 - my; y++) {
      for (let x = p.x0 + mx; x <= p.x1 - mx; x++) {
        cells++;
        if (label[y * cols + x] !== p.id) holes++;
      }
    }
    const off = page ? Math.abs(p.b - page.b) + Math.abs(p.g - page.g) + Math.abs(p.r - page.r) : 0;
    out.push({
      x: Math.round(real.x + (((p.x0 + p.x1 + 1) / 2) * step) / sx),
      y: Math.round(real.y + (((p.y0 + p.y1 + 1) / 2) * step) / sy),
      w: Math.round(((p.x1 - p.x0 + 1) * step) / sx),
      h: Math.round(((p.y1 - p.y0 + 1) * step) / sy),
      empty: holes <= cells * 0.004,
      tint: off > 10 && off <= 110,
    });
  }
  const line = 24 / sy;
  return out.sort((a, b) => Math.round(a.y / line) - Math.round(b.y / line) || a.x - b.x);
}

/** Whether anything stands out from the main colour of an area. */
function hasInk(image, rect, box) {
  const { width: W, height: H } = image.getSize();
  const px = image.toBitmap();
  const real = screen.dipToScreenRect(null, rect);
  const [sx, sy] = [W / real.width, H / real.height];
  const x0 = Math.max(0, Math.round((box.x - box.w / 2 - real.x) * sx));
  const x1 = Math.min(W - 1, Math.round((box.x + box.w / 2 - real.x) * sx));
  const y0 = Math.max(0, Math.round((box.y - box.h / 2 - real.y) * sy));
  const y1 = Math.min(H - 1, Math.round((box.y + box.h / 2 - real.y) * sy));
  if (x1 <= x0 || y1 <= y0) return false;
  const counts = new Map();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const [mb, mg, mr] = [((main >> 8) & 15) * 16 + 8, ((main >> 4) & 15) * 16 + 8, (main & 15) * 16 + 8];
  let [off, all] = [0, 0];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      all++;
      if (Math.abs(px[i] - mb) + Math.abs(px[i + 1] - mg) + Math.abs(px[i + 2] - mr) > 70) off++;
    }
  }
  return off >= 4 && off / all > 0.012;
}

/** Whether a slot has something in it now. */
const boxHolds = (image, rect, box) => hasInk(image, rect, { x: box.x, y: box.y, w: box.w * 0.64, h: box.h * 0.6 });

/** Blank slots shown only by a pale tint, with no border. There are two alike, or one and some tiles. */
function tintedPlaces(boxes, known, found) {
  const listed = known.filter((e) => e.w && e.h && e.type !== 'text');
  const tinted = boxes.filter(
    (b) =>
      b.empty &&
      b.tint &&
      !listed.some((e) => Math.abs(b.x - e.x) < e.w / 2 && Math.abs(b.y - e.y) < e.h / 2) &&
      !found.some((p) => Math.abs(b.x - p.x) < p.w / 2 && Math.abs(b.y - p.y) < p.h / 2),
  );
  const alike = tinted.filter((b) => tinted.some((o) => o !== b && Math.abs(o.w - b.w) <= b.w * 0.25 && Math.abs(o.h - b.h) <= b.h * 0.25));
  const keep = alike.length ? alike : tinted.length === 1 && boxes.filter((b) => !b.empty).length >= 2 ? tinted : [];
  const first = found.filter((p) => p.name.startsWith('empty box')).length;
  return keep.map((b, n) => ({ type: 'place', name: `empty box ${first + n + 1}`, value: '', state: '', x: b.x, y: b.y, w: b.w, h: b.h }));
}

/** The empty places in a picture, in reading order. A box with so much as one thin letter in it isn't one. */
function openPlaces(image, rect, listed, boxes) {
  const inFull = (p) => boxes.some((b) => !b.empty && Math.abs(p.x - b.x) < b.w / 2 && Math.abs(p.y - b.y) < b.h / 2);
  // The edge of a panel of tiles can look like a blank line, but a real gap has room on it.
  const crowded = (p) =>
    p.name.startsWith('empty gap') &&
    boxes.some((t) => {
      if (t.empty) return false;
      const across = Math.min(p.x + p.w / 2, t.x + t.w / 2) - Math.max(p.x - p.w / 2, t.x - t.w / 2);
      const down = Math.min(p.y + p.h / 2, t.y + t.h / 2) - Math.max(p.y - p.h / 2, t.y - t.h / 2);
      return across > 0 && down > 0 && across * down > 0.08 * t.w * t.h;
    });
  const marked = emptyPlaces(image, rect, listed).filter((p) => !inFull(p) && !crowded(p));
  return [...marked, ...tintedPlaces(boxes, listed, marked)].sort((a, b) => (Math.abs(a.y - b.y) < 14 ? a.x - b.x : a.y - b.y));
}

/** The frame as it is now, with its boxes and places. */
async function lookAgain(rect) {
  const [image, found] = await Promise.all([captureFrame(), frameElements(rect).catch(() => [])]);
  const known = found.filter((e) => !((e.type === 'button' || e.type === 'hyperlink') && SUBMIT_WORDS.test(e.name)));
  const boxes = pictureBoxes(image, rect);
  return { image, rect, known, boxes, places: openPlaces(image, rect, found, boxes) };
}

/** The part of the picture a box covers, a few times bigger, for reading. */
function boxPicture(image, rect, box) {
  const { width: W, height: H } = image.getSize();
  const real = screen.dipToScreenRect(null, rect);
  const [sx, sy] = [W / real.width, H / real.height];
  const x = Math.max(0, Math.round((box.x - box.w / 2 - real.x) * sx) + 1);
  const y = Math.max(0, Math.round((box.y - box.h / 2 - real.y) * sy) + 1);
  const width = Math.min(W - x, Math.round(box.w * sx) - 2);
  const height = Math.min(H - y, Math.round(box.h * sy) - 2);
  if (width < 6 || height < 6) return null;
  const crop = image.crop({ x, y, width, height });
  return { crop, big: crop.resize({ width: width * 3, height: height * 3, quality: 'best' }) };
}

/** What a box says: from Windows' list if it is there, else read off the picture, else by the model. */
async function tileName(box, view, memo, signal) {
  const inside = view.known.filter(
    (e) => e.name && e.name.length <= 40 && !['place', 'group', 'image'].includes(e.type) && Math.abs(e.x - box.x) <= box.w / 2 + 2 && Math.abs(e.y - box.y) <= box.h / 2 + 2,
  );
  const control = inside.find((e) => e.type !== 'text');
  if (control) return tileValue(control.name);
  const texts = inside.filter((e) => e.type === 'text');
  if (texts.length === 2 && Math.abs(texts[0].x - texts[1].x) < 12 && texts.every((e) => /^-?\d+$/.test(e.name.trim()))) {
    const [a, b] = [...texts].sort((p, q) => p.y - q.y);
    return `${a.name.trim()}/${b.name.trim()}`;
  }
  if (texts.length) return tileValue([...texts].sort((p, q) => p.x - q.x).map((e) => e.name).join(' '));
  const picture = boxPicture(view.image, view.rect, box);
  if (!picture) return '';
  const bytes = picture.crop.toBitmap();
  let key = 2166136261;
  for (let i = 0; i < bytes.length; i += 3) key = Math.imul(key ^ bytes[i], 16777619);
  if (memo.has(key)) return memo.get(key);
  let name = '';
  const bar = fractionBar(view.image, view.rect, box);
  if (bar !== null) {
    const [top, bottom] = [box.y - box.h / 2, box.y + box.h / 2];
    const upper = boxPicture(view.image, view.rect, { x: box.x, y: (top + bar) / 2 - 1, w: box.w, h: bar - top - 2 });
    const lower = boxPicture(view.image, view.rect, { x: box.x, y: (bar + bottom) / 2 + 1, w: box.w, h: bottom - bar - 2 });
    if (upper && lower) {
      const [a, b] = [await readTile(upper, signal), await readTile(lower, signal)];
      if (/^-?\d+$/.test(a) && /^\d+$/.test(b)) name = `${a}/${b}`;
    }
  }
  if (!name) name = await readTile(picture, signal);
  memo.set(key, name);
  return name;
}

/** Reads a picture of a tile: Windows' reader first, then the model for what it misses. */
async function readTile(picture, signal) {
  const file = path.join(app.getPath('temp'), `screensage-tile-${process.pid}.png`);
  let name = '';
  try {
    fs.writeFileSync(file, picture.big.toPNG());
    const words = await input.readWords(file);
    const lines = new Map();
    for (const w of words) lines.set(w.line, [...(lines.get(w.line) || []), w]);
    const said = [...lines.values()].sort((a, b) => a[0].y - b[0].y).map((l) => l.sort((a, b) => a.x - b.x).map((w) => w.t).join(' '));
    name = said.length === 2 && said.every((t) => /^-?\d+$/.test(t)) ? `${said[0]}/${said[1]}` : tileValue(said.join(' '));
  } catch {
    name = '';
  } finally {
    fs.rmSync(file, { force: true });
  }
  if (name && name.length <= 24) return name;
  // A lone letter or sign is what the reader tends to miss.
  const reply = await shortReply({
    messages: [
      { role: 'system', content: 'The picture is one tile from a quiz. Reply with only what is written on it, exactly: a letter, word, number or sign. Write a fraction as a/b. If it is blank, reply: blank' },
      { role: 'user', content: 'What is on this tile?', images: [picture.big.toJPEG(92).toString('base64')] },
    ],
    temperature: 0,
    signal,
    most: 40,
  }).catch((error) => {
    if (signal.aborted) throw error;
    return '';
  });
  const read = tileValue(toPlain(answerOf(reply) || reply).trim().replace(/^["'`]|["'`.]$/g, ''));
  return /^blank$/i.test(read) ? '' : read;
}

/** Where a fraction's bar is in a box (real pixels): a thin line across the middle, with marks above and below it. */
function fractionBar(image, rect, box) {
  const { width: W, height: H } = image.getSize();
  const px = image.toBitmap();
  const real = screen.dipToScreenRect(null, rect);
  const [sx, sy] = [W / real.width, H / real.height];
  const x0 = Math.max(0, Math.round((box.x - box.w / 2 - real.x) * sx) + 2);
  const x1 = Math.min(W - 1, Math.round((box.x + box.w / 2 - real.x) * sx) - 2);
  const y0 = Math.max(0, Math.round((box.y - box.h / 2 - real.y) * sy) + 2);
  const y1 = Math.min(H - 1, Math.round((box.y + box.h / 2 - real.y) * sy) - 2);
  if (x1 - x0 < 12 || y1 - y0 < 16) return null;
  const c = ((y0 + 1) * W + x0 + 1) * 4;
  const ink = (x, y) => {
    const i = (y * W + x) * 4;
    return Math.abs(px[i] - px[c]) + Math.abs(px[i + 1] - px[c + 1]) + Math.abs(px[i + 2] - px[c + 2]) > 90;
  };
  const inRow = (y, a, b) => {
    let n = 0;
    for (let x = a; x <= b; x++) if (ink(x, y)) n++;
    return n;
  };
  const gap = Math.max(2, Math.round(2 * sy));
  const height = y1 - y0;
  for (let y = y0 + Math.round(height * 0.32); y <= y0 + Math.round(height * 0.68); y++) {
    let [best, start, run, runStart] = [0, 0, 0, 0];
    for (let x = x0; x <= x1; x++) {
      if (ink(x, y)) {
        if (!run) runStart = x;
        run++;
        if (run > best) [best, start] = [run, runStart];
      } else run = 0;
    }
    if (best < 10 * sx || best > (x1 - x0) * 0.85) continue;
    const end = start + best - 1;
    // Clear just above and below the line, so it isn't the middle stroke of a letter.
    if (inRow(y - gap - 1, start, end) > best * 0.15 || inRow(y + gap + 1, start, end) > best * 0.15) continue;
    let [above, below] = [0, 0];
    for (let r = y0; r < y - gap; r++) above += inRow(r, start, end);
    for (let r = y + gap + 1; r <= y1; r++) below += inRow(r, start, end);
    if (above >= 6 && below >= 6) return real.y + y / sy;
  }
  return null;
}

/** The tiles waiting to be placed: anything short outside the slots. */
async function poolTiles(view, homes, memo, signal) {
  const real = screen.dipToScreenRect(null, view.rect);
  const scale = real.width / view.rect.width;
  const inHome = (t) => homes.some((h) => Math.abs(t.x - h.x) < h.w / 2 + 3 && Math.abs(t.y - h.y) < h.h / 2 + 3);
  const out = [];
  for (const b of view.boxes) {
    if (b.empty || inHome(b) || b.h > 120 * scale || b.w > 260 * scale) continue;
    const name = await tileName(b, view, memo, signal);
    if (name && name.length <= 24 && !SUBMIT_WORDS.test(name)) out.push({ ...b, name });
    if (out.length >= 16) break;
  }
  const kinds = new Set(['button', 'splitbutton', 'listitem', 'custom', 'menuitem']);
  for (const e of view.known) {
    if (!kinds.has(e.type) || !e.name || e.name.length > 24 || inHome(e)) continue;
    if (out.some((t) => Math.abs(t.x - e.x) < t.w / 2 && Math.abs(t.y - e.y) < t.h / 2)) continue;
    out.push({ x: e.x, y: e.y, w: e.w, h: e.h, name: tileValue(e.name) });
  }
  return out;
}

/** The names an answer mentions, in the order it mentions them. */
function namesIn(answer, names) {
  const plain = toPlain(answer).replace(/\s+/g, ' ').replace(/[−–—]/g, '-');
  const hits = [];
  for (const name of new Set(names)) {
    const safe = name.replace(/[.*+?^$()|[\]{}\\/-]/g, '\\$&');
    // A lone letter must match exactly, or the word "a" would count as tile A.
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}/.])${safe}(?![\\p{L}\\p{N}/])`, name.length === 1 ? 'gu' : 'giu');
    for (const m of plain.matchAll(pattern)) hits.push({ at: m.index, end: m.index + m[0].length, name });
  }
  hits.sort((a, b) => a.at - b.at || b.end - a.end);
  const order = [];
  let reached = 0;
  for (const h of hits) {
    if (h.at < reached) continue;
    order.push(h.name);
    reached = h.end;
  }
  if (order.length) return order;
  // "ACBD" with no spaces, for single-letter tiles.
  const joined = [...plain.replace(/[^\p{L}\p{N}]/gu, '')];
  return names.every((n) => n.length === 1) && joined.length && joined.every((c) => names.includes(c)) ? joined : [];
}

/** Tiles to go into blank slots, if the answer says which tile goes where. */
async function tilePlan(answer, view, memo, signal) {
  const { places } = view;
  if (!places.length) return null;
  const pool = await poolTiles(view, places, memo, signal);
  if (pool.length < places.length) return null;
  const names = pool.map((t) => t.name);
  const order = namesIn(answer, names);
  if (order.length !== places.length) return null;
  for (const name of new Set(order)) {
    if (order.filter((n) => n === name).length > names.filter((n) => n === name).length) return null;
  }
  return { order, homes: places.map(({ x, y, w, h }) => ({ x, y, w, h })) };
}

/** Put one tile in a slot, however this page does it: a tap, a tap and then the slot, or a drag. */
async function placeTile(tile, spot, rect, how, signal, open) {
  const check = () => {
    if (signal.aborted) throw Object.assign(new Error('stopped'), { code: 'aborted' });
  };
  const landed = async () => {
    await pause(280, signal);
    const now = await lookAgain(rect);
    // The page can close up once a tile has gone, so a slot fewer counts as well as the slot itself.
    const held = now.places.length < open || boxHolds(now.image, rect, spot);
    if (process.env.SAGE_DEBUG) console.log(`tile "${tile.name}" at ${tile.x},${tile.y} to ${spot.x},${spot.y}: ${held ? 'landed' : 'not yet'}`);
    return held;
  };
  if (how.way === 'drag') {
    await aside(rect, () => dragBetween(tile, spot, check));
    return landed();
  }
  await aside(rect, () => clickAt(tile));
  if (how.way !== 'then' && (await landed())) {
    how.way = 'tap';
    return true;
  }
  await aside(rect, () => clickAt(spot));
  if (await landed()) {
    how.way = 'then';
    return true;
  }
  await aside(rect, () => dragBetween(tile, spot, check));
  if (await landed()) {
    how.way = 'drag';
    return true;
  }
  return false;
}

/** Each tile into the next free slot, looking again after each, since the page moves things about. */
async function fillTiles(plan, view, memo, signal) {
  const how = {};
  let done = 0;
  let look = view;
  for (const want of plan.order) {
    if (done) look = await lookAgain(view.rect);
    const spot = look.places[0];
    if (!spot) return { done, ok: false };
    const homes = [...plan.homes, ...look.places];
    const pool = (await poolTiles(look, homes, memo, signal)).filter((t) => Math.abs(t.y - spot.y) >= spot.h * 0.6);
    const tile = pool.find((t) => sameValue(t.name, want));
    if (!tile || !(await placeTile(tile, spot, view.rect, how, signal, look.places.length))) return { done, ok: false };
    done++;
  }
  return { done, ok: true };
}

/**
 * A line of boxes set in text ("y = [ ] x [ ] [ ]"), each of which opens its own choices. Plain rows of
 * answer buttons aren't this: they have no text between them, and nothing says they want filling in.
 */
function slotRow(answer, view) {
  const { image, rect, known, boxes } = view;
  const scale = screen.dipToScreenRect(null, rect).width / rect.width;
  const fixed = new Set(['edit', 'combobox', 'document', 'spinner', 'radiobutton', 'checkbox', 'slider']);
  const free = boxes.filter(
    (b) => b.h <= 110 * scale && b.w <= 260 * scale && !known.some((e) => fixed.has(e.type) && Math.abs(e.x - b.x) <= Math.max(e.w, b.w) / 2 && Math.abs(e.y - b.y) <= Math.max(e.h, b.h) / 2),
  );
  const rows = [];
  for (const b of free) {
    const row = rows.find((r) => Math.abs(r.y - b.y) < Math.max(r.h, b.h) * 0.5);
    if (row) row.slots.push(b);
    else rows.push({ y: b.y, h: b.h, slots: [b] });
  }
  for (const row of rows.sort((a, b) => a.y - b.y)) {
    row.slots.sort((a, b) => a.x - b.x);
    const { slots } = row;
    if (Math.max(...slots.map((s) => s.h)) > Math.min(...slots.map((s) => s.h)) * 1.6) continue;
    const margin = 6 * scale;
    const band = row.h * 0.7;
    let inline = hasInk(image, rect, { x: slots[0].x - slots[0].w / 2 - margin - 50 * scale, y: row.y, w: 100 * scale, h: band });
    for (let n = 1; n < slots.length && !inline; n++) {
      const [left, right] = [slots[n - 1].x + slots[n - 1].w / 2 + margin, slots[n].x - slots[n].w / 2 - margin];
      if (right - left >= 4 * scale) inline = hasInk(image, rect, { x: (left + right) / 2, y: row.y, w: right - left, h: band });
    }
    if (!inline) continue;
    const others = boxes.filter((b) => !b.empty && !slots.includes(b) && Math.abs(b.y - row.y) > row.h);
    if (!slots.some((s) => s.empty) && others.length < 3 && !/=/.test(toPlain(answer))) continue;
    const inBox = (e) => slots.some((s) => Math.abs(e.x - s.x) <= s.w / 2 + 2 && Math.abs(e.y - s.y) <= s.h / 2 + 2);
    const words = known.filter((e) => e.type === 'text' && Math.abs(e.y - row.y) < row.h * 0.6 && !inBox(e));
    const sequence = [
      ...slots.map((s, slot) => ({ x: s.x, slot })),
      ...words.flatMap((e) => mathTokens(e.name).map((lit, n) => ({ x: e.x - e.w / 2 + n, lit }))),
    ].sort((a, b) => a.x - b.x);
    return { ...row, sequence };
  }
  return null;
}

/** What goes in each box of the row, from the answer, or by asking the model if it doesn't line up. */
async function slotAnswers(answer, row, view, signal) {
  const plain = toPlain(answer).trim();
  let { sequence } = row;
  // Nothing listed the row's words (a canvas): read them off the picture.
  if (!sequence.some((s) => s.lit != null)) {
    const [left, right] = [row.slots[0].x - row.slots[0].w / 2 - 130, row.slots[row.slots.length - 1].x + row.slots[row.slots.length - 1].w / 2 + 40];
    const strip = boxPicture(view.image, view.rect, { x: (left + right) / 2, y: row.y, w: right - left, h: row.h });
    if (strip) {
      const file = path.join(app.getPath('temp'), `screensage-row-${process.pid}.png`);
      try {
        fs.writeFileSync(file, strip.big.toPNG());
        const words = await input.readWords(file);
        const k = strip.big.getSize().width / (right - left);
        const inBox = (x) => row.slots.some((s) => Math.abs(x - s.x) <= s.w / 2);
        const lits = words
          .map((w) => ({ x: left + (w.x + w.w / 2) / k, t: w.t }))
          .filter((w) => !inBox(w.x))
          .flatMap((w) => mathTokens(w.t).map((lit) => ({ x: w.x, lit })));
        sequence = [...sequence, ...lits].sort((a, b) => a.x - b.x);
      } catch {
        // The model is asked below.
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  }
  const lined = alignParts(mathTokens(plain), sequence);
  if (lined) return lined;
  const count = row.slots.length;
  const list = plain.split(/\n|;|,/).map((l) => l.trim().replace(/^[-•*]\s+/, '')).filter(Boolean);
  if (list.length === count) return list.map((l) => cleanValue(l.replace(/^.*[:=]\s*/, '')));
  const shape = sequence.map((s) => (s.lit != null ? s.lit : `[box ${s.slot + 1}]`)).join(' ');
  const ask = async (how) => {
    const reply = await shortReply({
      messages: [
        {
          role: 'system',
          content: [
            'Read the question in the capture and work out its whole answer.',
            `The answer goes into a line that reads: ${shape}`,
            'What the boxes show now may be wrong, and an open list of choices is not the answer, so ignore them.',
            ...(mathTokens(plain).length >= count ? [`The answer is: ${plain}`] : []),
            how,
          ].join('\n'),
        },
        { role: 'user', content: 'What is the answer?', images: [view.image.toJPEG(88).toString('base64')] },
      ],
      temperature: 0,
      signal,
      most: 200,
    }).catch((error) => {
      if (signal.aborted) throw error;
      return '';
    });
    if (process.env.SAGE_DEBUG) console.log(`row reply: ${JSON.stringify(reply)}`);
    return String(reply || '').replace(/<\/?answer>/gi, '');
  };
  // The whole line first: signs and numbers then fall into their own boxes.
  const whole = alignParts(mathTokens(await ask('Reply with only that line, written out with the right values in place of the boxes. Write a fraction as a/b.')), sequence);
  if (whole) return whole;
  const raw = await ask(`Reply with exactly ${count} lines, what goes in each box in order, and nothing else. A sign goes in its own box if the line has one for it. Write a fraction as a/b.`);
  const said = raw.split('\n').map((l) => cleanValue(l.replace(/^\s*(?:\[?box\s*\d+\]?\s*[:=]?|\d+[.)]\s)\s*/i, '').replace(/[`*]/g, ''))).filter(Boolean);
  return said.length === count ? said : alignParts(mathTokens(raw), sequence);
}

/** The choices showing now: every short tile that isn't in the row itself. */
async function shownOptions(look, row, memo, signal) {
  const scale = screen.dipToScreenRect(null, look.rect).width / look.rect.width;
  const out = [];
  for (const b of look.boxes) {
    if (b.empty || Math.abs(b.y - row.y) < row.h * 0.7 || b.h > 120 * scale || b.w > 260 * scale) continue;
    const name = await tileName(b, look, memo, signal);
    if (name && name.length <= 24 && !SUBMIT_WORDS.test(name)) out.push({ ...b, name });
    if (out.length >= 24) break;
  }
  const kinds = new Set(['listitem', 'menuitem', 'button', 'splitbutton', 'custom', 'dataitem']);
  for (const e of look.known) {
    if (!kinds.has(e.type) || !e.name || e.name.length > 24 || Math.abs(e.y - row.y) < row.h * 0.7) continue;
    if (out.some((t) => Math.abs(t.x - e.x) < t.w / 2 && Math.abs(t.y - e.y) < t.h / 2)) continue;
    out.push({ x: e.x, y: e.y, w: e.w, h: e.h, name: tileValue(e.name) });
  }
  return out;
}

/** The choice that means the same as the wanted value, when none is written the same way. */
async function pickOption(want, options, image, signal) {
  const names = [...new Set(options.map((o) => o.name))];
  const reply = await shortReply({
    messages: [
      {
        role: 'system',
        content: [`A box in a question needs the value: ${want}`, 'These are its choices:', ...names.map((n) => `- ${n}`), 'Reply with only the choice that means the same, copied exactly. If none does, reply: none'].join('\n'),
      },
      { role: 'user', content: 'Which choice?', images: [image.toJPEG(88).toString('base64')] },
    ],
    temperature: 0,
    signal,
    most: 60,
  }).catch((error) => {
    if (signal.aborted) throw error;
    return '';
  });
  const said = toPlain(answerOf(reply) || reply).trim();
  const name = names.find((n) => sameValue(n, said));
  return name ? options.find((o) => o.name === name) : null;
}

/** Open each box in the row and press the choice it needs. Null if the boxes turn out not to open anything. */
async function fillSlots(row, answer, view, memo, signal) {
  const parts = await slotAnswers(answer, row, view, signal);
  if (process.env.SAGE_DEBUG) console.log(`slot answers: ${parts ? parts.join(' | ') : 'none'}`);
  if (!parts) return null;
  const { rect } = view;
  const current = (look) => {
    const same = look.boxes.filter((b) => Math.abs(b.y - row.y) < row.h * 0.6 && b.h <= row.h * 1.5 && b.h >= row.h * 0.6).sort((a, b) => a.x - b.x);
    return same.length === row.slots.length ? same : row.slots;
  };
  let done = 0;
  for (let pass = 0; pass < 2; pass++) {
    let wrong = 0;
    for (let n = 0; n < parts.length; n++) {
      const look = await lookAgain(rect);
      const slot = current(look)[n];
      const holds = boxHolds(look.image, rect, slot) ? await tileName(slot, look, memo, signal) : '';
      if (holds && sameValue(holds, parts[n])) continue;
      wrong++;
      await aside(rect, () => clickAt(slot));
      await pause(380, signal);
      const open = await lookAgain(rect);
      const options = await shownOptions(open, row, memo, signal);
      if (process.env.SAGE_DEBUG) console.log(`box ${n + 1} holds "${holds}", wants "${parts[n]}", choices: ${options.map((o) => o.name).join(' ')}`);
      if (!options.length) return done ? { done, ok: false } : null;
      const pick = options.find((o) => sameValue(o.name, parts[n])) || (await pickOption(parts[n], options, open.image, signal));
      if (!pick) return done ? { done, ok: false } : null;
      await aside(rect, () => clickAt(pick));
      await pause(320, signal);
      done++;
    }
    if (!wrong) return { done, ok: true };
  }
  return { done, ok: true };
}

/** Questions made of boxes the page draws itself. Null when this isn't one. */
async function fillBoxes(answer, view, signal) {
  if (!view.boxes.length) return null;
  const memo = new Map();
  const plan = await tilePlan(answer, view, memo, signal);
  if (process.env.SAGE_DEBUG) console.log(`boxes: ${view.boxes.map((b) => `${b.empty ? 'empty' : 'full'}${b.tint ? '/tint' : ''} ${b.x},${b.y} ${b.w}x${b.h}`).join('; ')}\nplaces: ${view.places.map((p) => `${p.name} ${p.x},${p.y} ${p.w}x${p.h}`).join('; ')}\ntile plan: ${plan ? plan.order.join(' ') : 'none'}`);
  if (plan) return fillTiles(plan, view, memo, signal);
  const row = slotRow(answer, view);
  if (process.env.SAGE_DEBUG) console.log(`slot row: ${row ? row.sequence.map((p) => (p.lit != null ? p.lit : `[${p.slot}]`)).join(' ') : 'none'}`);
  return row ? fillSlots(row, answer, view, memo, signal) : null;
}

/** How many separate answers the page takes, when that can be told from its controls. */
function partsNeeded(elements) {
  const fields = elements.filter((e) => TYPING.has(e.type) && !/\b(?:search|find|filter|url|address)\b/i.test(e.name));
  if (fields.length > 1) return { count: fields.length, letters: fields.every((e) => e.type === 'edit' && (e.w || 99) <= 60) };
  const rows = [];
  for (const r of elements.filter((e) => e.type === 'radiobutton')) {
    const row = rows.find((o) => Math.abs(o.y - r.y) < 14);
    if (row) row.n++;
    else rows.push({ y: r.y, n: 1 });
  }
  return rows.length >= 2 && rows.every((r) => r.n >= 2) ? { count: rows.length, letters: false } : null;
}

/** An answer that covers fewer boxes or questions than the page has: ask for all of them. */
async function completeAnswer(answer, elements, image, signal) {
  const need = partsNeeded(elements);
  if (!need) return answer;
  const plain = toPlain(answer).trim();
  const count = (t) => {
    if (need.letters) return [...t].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length > 1 ? lines.length : t.split(/\s*(?:[,;]|\band\b|\s)\s*/i).filter(Boolean).length;
  };
  if (count(plain) >= need.count) return answer;
  const reply = await shortReply({
    messages: [
      {
        role: 'system',
        content: [
          'You are looking at a capture of a question with several parts.',
          need.letters ? `It has ${need.count} boxes that take one letter or digit each, for one word or number.` : `It has ${need.count} separate boxes or questions.`,
          `The answer so far only covers part of it: ${plain}`,
          need.letters
            ? `Reply with the whole word or number, exactly ${need.count} characters long, and nothing else.`
            : `Reply with exactly ${need.count} answers, one per line, in order from the top of the page. Each is only the value or option. Nothing else.`,
        ].join('\n'),
      },
      { role: 'user', content: 'Give the full answer.', images: [image.toJPEG(88).toString('base64')] },
    ],
    temperature: 0,
    signal,
    most: 400,
  }).catch((error) => {
    if (signal.aborted) throw error;
    return '';
  });
  const fuller = toPlain(answerOf(reply) || reply).trim();
  return fuller && count(fuller) === need.count ? fuller : answer;
}

/**
 * An answer that names none of the options, as when they are pictures whose names only Windows can
 * read: choose from those names. Null when it doesn't apply or none of them fits.
 */
async function answerAmongOptions(answer, elements, image, signal) {
  const kinds = new Set(['button', 'splitbutton', 'radiobutton', 'checkbox', 'listitem', 'menuitem', 'custom', 'image']);
  const options = elements.filter((e) => kinds.has(e.type) && e.name && e.name.length <= 40);
  if (options.length < 2 || options.length > 12 || elements.some((e) => TYPING.has(e.type) || e.type === 'place')) return null;
  const plain = toPlain(answer).trim();
  if (options.some((e) => saysName(plain, e.name))) return null;
  const names = [...new Set(options.map((e) => e.name.trim()))];
  const reply = await shortReply({
    messages: [
      {
        role: 'system',
        content: [
          'Read the question in the capture and answer it by choosing from these options.',
          'They may show as pictures or blank squares, so go by their names:',
          ...names.map((n) => `- ${n}`),
          'Reply with only the name of the right option, copied exactly. If several are right, one per line. If none of them fits, reply: none',
        ].join('\n'),
      },
      { role: 'user', content: 'Which option is the answer?', images: [image.toJPEG(88).toString('base64')] },
    ],
    temperature: 0,
    signal,
    most: 200,
  }).catch((error) => {
    if (signal.aborted) throw error;
    return '';
  });
  const lines = toPlain(answerOf(reply) || reply).split('\n').map((l) => l.trim().replace(/^[-•*]\s+/, '')).filter(Boolean);
  const picked = lines.map((l) => names.find((n) => simple(n) === simple(l)));
  return picked.length && picked.every(Boolean) ? [...new Set(picked)].join('\n') : null;
}

/** The words on a page that lists no controls (a canvas, a game), read off the screen. */
async function wordsOnPage(rect, listed) {
  const seen = await readScreen(rect).catch(() => ({ phrases: [] }));
  const known = new Set(listed.map((e) => simple(e.name)));
  return seen.phrases
    .filter((p) => simple(p.text) && !known.has(simple(p.text)) && !SUBMIT_WORDS.test(p.text))
    .map((p) => ({ type: 'text', name: p.text, value: '', state: '', x: Math.round((p.box.left + p.box.right) / 2), y: Math.round((p.box.top + p.box.bottom) / 2), w: Math.round(p.box.right - p.box.left), h: Math.round(p.box.bottom - p.box.top) }))
    .slice(0, 30);
}

/** Did the moves take? Anything the page doesn't report counts as done. */
async function planLanded(actions, elements, rect) {
  const now = await frameElements(rect).catch(() => []);
  const fresh = (e) => {
    let best = null;
    for (const f of now) {
      if (f.type !== e.type || f.name !== e.name) continue;
      const d = Math.hypot(f.x - e.x, f.y - e.y);
      if (!best || d < best.d) best = { f, d };
    }
    return best && best.f;
  };
  return actions.every((a) => {
    if (a.type === 'click') {
      if (a.on === undefined || !elements[a.target].state) return true;
      const f = fresh(elements[a.target]);
      return !f || isOn(f) === a.on;
    }
    if (a.type === 'drag') {
      const [card, target] = [elements[a.from], elements[a.to]];
      // A place or box has edges to be inside; a label only marks where its box is.
      const [rx, ry] = target.type === 'text' ? [70, 70] : [(target.w || 0) / 2 + 6, (target.h || 0) / 2 + 6];
      return now.some((e) => e.type === card.type && e.name === card.name && Math.abs(e.x - target.x) <= rx && Math.abs(e.y - target.y) <= ry);
    }
    if (a.type === 'slider') {
      const f = fresh(elements[a.target]);
      return !!f && Number(f.value) === a.value;
    }
    if (a.type === 'type' || a.type === 'choose') {
      const f = fresh(elements[a.target]);
      if (!f) return true;
      const held = simple(f.value);
      return /^[•*●]+$/.test(String(f.value).trim()) || (!!held && held.includes(simple(a.text)));
    }
    if (a.type === 'sort') {
      const cards = a.order.map((i) => fresh(elements[i]));
      if (cards.some((c) => !c)) return false;
      const along = Math.max(...cards.map((c) => c.y)) - Math.min(...cards.map((c) => c.y)) >= Math.max(...cards.map((c) => c.x)) - Math.min(...cards.map((c) => c.x)) ? 'y' : 'x';
      return cards.every((c, k) => k === 0 || c[along] > cards[k - 1][along]);
    }
    return true;
  });
}

/**
 * Fill in: the model looks at the frame (and the controls in it), works out what kind of question
 * it is, and enters the answer. Then it looks again to check, and fixes what is missing, a few times at most.
 */
async function fillCore(given, controller) {
  let answer = given;
  const providerId = settings.provider;
  const done = []; // what happened, in words, for the next look
  const acted = []; // the kinds of thing actually done
  let lastPlan = '';
  for (let roundNo = 0; roundNo < FILL_ROUNDS && !controller.signal.aborted; roundNo++) {
    const rect = { ...settings.frame };
    const [image, found] = await Promise.all([captureFrame(), frameElements(rect).catch(() => [])]);
    // Buttons that hand the answer in are never Fill in's to press, so they aren't offered.
    const listed = found.filter((e) => !((e.type === 'button' || e.type === 'hyperlink') && SUBMIT_WORDS.test(e.name)));
    // Empty boxes and gaps to drop things into, which Windows can't list, are found in the picture.
    // A page that lists next to nothing (a canvas, a game): read its words off the screen.
    const fewThings = listed.filter((e) => e.type !== 'text' || e.name.length <= 40).length < 2;
    const read = fewThings ? await wordsOnPage(rect, listed) : [];
    const known = [...listed, ...read];
    const boxes = pictureBoxes(image, rect);
    const places = openPlaces(image, rect, [...found, ...read], boxes);
    const elements = [...known, ...places, ...colourShapes(image, rect, known)];
    const note = done.length
      ? `Already done: ${done.join('; ')}.\nThis is the screen now. Check it: if the answer is fully in, reply done. Otherwise give only the commands for what is still missing or wrong.`
      : 'This is the screen now.';
    const hint = lastFill && lastFill.frame === frameKey(rect) && Date.now() - lastFill.time < 30 * 60000 ? lastFill.how : '';
    if (roundNo === 0) answer = await completeAnswer(answer, elements, image, controller.signal);
    // Tiles into blank slots, and lines of boxes that each open their own choices.
    if (roundNo === 0) {
      const boxed = await fillBoxes(answer, { image, rect, known, boxes, places }, controller.signal);
      if (boxed && boxed.ok) {
        acted.push('box');
        break;
      }
      if (boxed && boxed.done) {
        acted.push('box');
        done.push(`put ${boxed.done} of the answers into their boxes`);
        await pause(500, controller.signal);
        continue;
      }
    }
    // Moves the answer already spells out don't need the model to work them out again.
    let clear = roundNo === 0 ? clearPlan(answer, elements) : null;
    if (roundNo === 0 && clear === null) {
      const picked = await answerAmongOptions(answer, elements, image, controller.signal);
      if (picked) {
        answer = picked;
        clear = clearPlan(answer, elements);
      }
    }
    if (clear && !clear.length) return 1; // it's already in
    const reply = clear
      ? clear.map((a) => JSON.stringify(a)).join('\n')
      : await shortReply({
          messages: [
            { role: 'system', content: fillPrompt(answer, elements, rect, hint) },
            { role: 'user', content: note, images: [markImage(image, rect, elements).toJPEG(90).toString('base64')] },
          ],
          signal: controller.signal,
        });
    if (process.env.SAGE_DEBUG) {
      const places = elements.filter((e) => e.type === 'place').map((e) => `${e.name} at ${onGrid(rect, e)}`);
      console.log(`fill round ${roundNo + 1}: ${elements.length} controls${places.length ? ` (${places.join(', ')})` : ''}\n${elements.map((e, i) => describeElement(e, i, rect)).join('\n')}\n${reply}`);
    }
    const plan = clear ? { actions: clear, look: false, skipped: [] } : readCommands(reply, elements);
    // A box that already holds this text doesn't need typing into again.
    const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    plan.actions = plan.actions.filter((a) => !((a.type === 'type' || a.type === 'choose') && a.target != null && elements[a.target].value && same(elements[a.target].value, a.text)));
    const notTyped = (a) => a.type === 'type' && a.target != null && UNTYPED.has(elements[a.target].type);
    for (const a of plan.actions.filter(notTyped)) {
      done.push(`could not type into #${a.target + 1} "${elements[a.target].name}": it is not a text box, so click it if it is the answer`);
    }
    if (plan.actions.some(notTyped)) {
      plan.actions = plan.actions.filter((a) => !notTyped(a));
      if (!plan.actions.length) continue;
    }
    // Commands that named nothing are told back, so the next look can put them right.
    for (const line of plan.skipped) {
      done.push(`could not follow "${line}": there is no thing with that number or name (for a place with no number, give X Y from the grid)`);
    }
    if (!plan.actions.length && !plan.skipped.length) break; // done
    if (!plan.actions.length) continue;
    // The same moves again would only undo them (a ticked box clicked twice).
    const key = JSON.stringify(plan.actions);
    if (key === lastPlan) break;
    lastPlan = key;
    await aside(rect, async () => {
      for (const [n, action] of plan.actions.entries()) {
        // Typing into a dropdown means picking that entry.
        if (action.type === 'type' && action.target != null && elements[action.target].type === 'combobox') action.type = 'choose';
        // The question's own words aren't a card to move.
        if (action.type === 'drag' && action.from != null && elements[action.from].type === 'text' && elements[action.from].name.length > 40) {
          done.push(`could not drag #${action.from + 1}: it is the question's text, not a card`);
          continue;
        }
        // Typing needs a text box; say so next round rather than typing into thin air.
        if (action.type === 'type' && action.target != null && !TYPING.has(elements[action.target].type)) {
          done.push(`could not type into #${action.target + 1}: it is not a text box`);
          continue;
        }
        await perform(action, rect, elements, controller.signal);
        done.push(actionWords(action, rect, elements));
        acted.push(action.type);
        // Cards slide along once one is dragged away: look where the rest are now.
        if ((action.type === 'drag' || action.moved) && n < plan.actions.length - 1) await relocate(elements, rect, plan.actions);
      }
    });
    await pause(plan.look ? 500 : 700, controller.signal); // let the page react before looking again
    if (clear) {
      await relocate(elements, rect, clear);
      if (await planLanded(clear, elements, rect)) break; // if not, the model takes it from here
    }
  }
  if (acted.length) {
    const how = [...new Set(acted)].map((k) => `${k} ×${acted.filter((x) => x === k).length}`).join(', ');
    lastFill = { frame: frameKey(settings.frame), time: Date.now(), how };
  }
  return acted.length;
}

const frameKey = (r) => `${Math.round(r.x / 40)},${Math.round(r.y / 40)},${Math.round(r.width / 40)},${Math.round(r.height / 40)}`;

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
  clearTimeout(frameBack);
  steady.on = true;
  // The frame only has to go if its shade would darken a look outside it.
  const looksOutside = kind === 'steps' && settings.frameStyle.shade && settings.steps.list.some((s) => s.type === 'click' || (s.type === 'find' && s.where === 'screen'));
  if (looksOutside && !frameQuiet) await quietFrame();
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
    runEnded = Date.now();
    tell('auto:state', { on: false, kind, error, result, stopped: controller.signal.aborted, next: !!chain && !error && !controller.signal.aborted });
    raiseFloating();
    frameReturns();
  }
}

/** The Fill in button: runs your blocks when you have some, or just fills in the answer. */
function fillIn() {
  const answer = latestAnswer();
  if (!answer || !settings.frameVisible) return;
  if (settings.steps.list.length) return runSteps();
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
  if (steady.on) return coverOurs(await captureRect(areaDip, { full: true, ...options }), areaDip);
  // During a run the frame is already faded out; otherwise it fades out for the picture and back.
  const overlayWins = frameQuiet ? [] : [...overlays].filter((win) => !win.isDestroyed() && win.isVisible());
  await Promise.all(overlayWins.map((win) => fadeTo(win, 0, 180)));
  try {
    return await aside(areaDip, async () => {
      await wait(80);
      return captureRect(areaDip, { full: true, ...options });
    });
  } finally {
    if (!frameQuiet) for (const win of overlayWins) fadeTo(win, OVERLAY_OPACITY, 260);
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

const lookAt = (system, question, image, signal) =>
  shortReply({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question, images: [image.toJPEG(88).toString('base64')] },
    ],
    temperature: 0,
    signal,
    most: 600,
  });

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
  // It may be under one of our windows: move that out of the way and look once more.
  if (steady.on) {
    const covering = [widget, timerWin].filter((win) => win && !win.isDestroyed() && win.isVisible() && !steady.out.has(win) && overlapArea(win.getBounds(), area) > 0);
    if (covering.length) {
      await stepOut(covering);
      return locate({ name, type, look, near, area, wide, description }, signal);
    }
  }
  if (type === 'look' && !description && name === 'What you pointed at') return null; // nothing to ask about
  return aiLocate(description || describe({ name, type }), area, signal).catch((error) => {
    if (signal.aborted) throw stopped();
    if (process.env.SAGE_DEBUG) console.error('locate:', error.message);
    return null;
  });
}

/** A small picture of an area (about a third of its size), for telling whether anything changed. */
async function snapshot(areaDip) {
  const image = coverOurs(await captureRect(areaDip, { full: true, shrink: 3 }), areaDip);
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
    await glide(p);
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
  // Words read off the screen only count inside the frame: the margin can show other apps, whose text changes by itself.
  const frame = screen.dipToScreenRect(null, settings.frame);
  const inFrame = ({ box: b }) => {
    const [x, y] = [(b.left + b.right) / 2, (b.top + b.bottom) / 2];
    return x >= frame.x - 6 && x <= frame.x + frame.width + 6 && y >= frame.y - 6 && y <= frame.y + frame.height + 6;
  };
  let image = null;
  const seen = await readScreen(areaDip, (read) => read.phrases.some(inFrame), (shot) => (image = shot)).catch(() => ({ phrases: [] }));
  const lines = [];
  for (const c of controls) {
    if (c.name && c.name.length <= 300) lines.push({ text: c.name, type: c.type, x: c.x, y: c.y, from: 'ui' });
  }
  for (const phrase of seen.phrases.filter(inFrame)) {
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
    clearTimeout(frameBack);
    letGo();
    showOverlays();
    for (const win of overlays) {
      win.setIgnoreMouseEvents(false);
      fadeTo(win, OVERLAY_OPACITY, 200);
    }
    // The widget fades and lets clicks through, so the spot can be under it too.
    if (widget && !widget.isDestroyed()) {
      fadeTo(widget, 0.25, 220);
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
    fadeTo(widget, 1, 260);
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
