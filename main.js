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

// The widget is a fixed width; its height follows what it is showing.
const WIDGET = { width: 320, minHeight: 60, maxHeight: 580, margin: 14 };
const TIMER = { width: 214, height: 52 };
// The frame is the capture area itself (screen coordinates). Its edge, handles
// and toolbar are drawn just outside it, so they never end up in the picture.
const HOLE_MIN = { width: 80, height: 48 };
const MAX_IMAGE_WIDTH = 1600;
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
    'How you got the answer, in a few short, clear steps.',
    '</working>',
    `If there is no question in the capture, put a one-sentence description of what it shows in <answer> and leave ${explain ? 'the other sections' : '<working>'} empty.`,
    'Write maths in plain text (x^2, sqrt(2), 3/4), never LaTeX or dollar signs.',
  ].join('\n');

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
    `The answer to enter:\n${answer}`,
    ...(elements.length
      ? [
          'These are the things inside the capture you can use, by number:',
          ...elements.map(describeElement),
          'Reply with commands only, one per line, nothing else:',
          'click N        click thing N (an option, checkbox or list item)',
          'type N text    put text into text box N (it replaces what is there)',
          'choose N text  pick the entry called text in dropdown N',
          'drag N M       drag thing N onto thing M',
        ]
      : [
          'Positions are on a 0 to 1000 grid over the capture: x across from the left edge, y down from the top edge.',
          'Reply with commands only, one per line, nothing else:',
          'click X Y      click at that position (aim for the centre of the option or box)',
          'type text      type into the box that was just clicked',
          'drag X1 Y1 X2 Y2   drag from one position to another',
        ]),
    'key enter      press a key: enter, tab, down or up',
    'look           stop and get a new capture first (for example after opening a custom list)',
    'done           the answer is fully entered',
    'Rules: only enter the answer, never press submit, next, check or finish. Leave options that are already right alone. Use the answer exactly as given.',
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
  answers: { think: false, explain: false, autoFill: false, showExplain: true, showWorking: false, showThinking: false, saveHistory: true },
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
    autoFill: !!p.autoFill,
    showExplain: !!p.showExplain,
    showWorking: !!p.showWorking,
    showThinking: !!p.showThinking,
    saveHistory: !!p.saveHistory,
  };
}

function loadSettings() {
  const saved = readJson('settings.json', {});
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
    visible: settings.frameVisible,
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
async function captureRect(rect) {
  const display = screen.getDisplayMatching(rect);
  const scale = display.scaleFactor || 1;
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
  if (width > MAX_IMAGE_WIDTH) image = image.resize({ width: MAX_IMAGE_WIDTH, quality: 'best' });
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

async function writeAnswer() {
  const controller = new AbortController();
  running = controller;
  const providerId = settings.provider;
  let thinking = '';
  try {
    const reply = await chat(providerId, {
      model: modelFor(providerId),
      apiKey: getKey(providerId),
      baseUrl: baseUrlFor(providerId),
      messages: conversation,
      think: settings.answers.think,
      signal: controller.signal,
      onChunk: (piece) => {
        if (running === controller) tell('answer:chunk', piece);
      },
      onThinking: (piece) => {
        thinking += piece;
        if (running === controller) tell('answer:thinking', piece);
      },
    });
    conversation.push({ role: 'assistant', content: reply, ...(thinking ? { thinking } : {}) });
    recordHistory();
    if (running === controller) tell('answer:done');
    return reply;
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
async function ask() {
  if (!widget || running || filling) return;
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
  const reply = await writeAnswer().catch(() => null);
  if (reply && settings.answers.autoFill) fillIn();
}

async function sendAfter(message, channel, payload) {
  if (!conversation || running) return;
  conversation.push({ role: 'user', content: message });
  tell(channel, payload);
  await writeAnswer().catch(() => {
    // Drop the message that got no answer so the conversation stays valid.
    if (conversation[conversation.length - 1].role === 'user') conversation.pop();
  });
}

const followUp = (input) => {
  const question = text(input, 2000).trim();
  if (question) sendAfter(question, 'answer:followup', question);
};

const retry = () => {
  if (conversation && conversation[conversation.length - 1].role === 'assistant') sendAfter(RETRY, 'answer:retry');
};

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

function latestAnswer() {
  const last = conversation && [...conversation].reverse().find((m) => m.role === 'assistant');
  if (!last) return '';
  const match = last.content.match(/<answer>\s*([\s\S]*?)\s*(?:<\/answer>|<explain>|<working>|$)/i);
  return (match ? match[1] : last.content.split(/\n\s*\n/)[0]).trim();
}

const unquote = (s) => s.trim().replace(/^["'“‘](.*)["'”’]$/, '$1');

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
    else if (count && (m = line.match(/^click\s+#?(\d+)\s*$/i)) && id(m[1]) !== null) actions.push({ type: 'click', target: id(m[1]) });
    else if (count && (m = line.match(/^type\s+#?(\d+)\s+(.+)$/i)) && id(m[1]) !== null) actions.push({ type: 'type', target: id(m[1]), text: unquote(m[2]) });
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
    await wait(500);
    list = await input.elements(pixels, process.pid);
  }
  // Labels that only repeat a control's name add nothing.
  const named = new Set(list.filter((e) => e.type !== 'text').map((e) => e.name));
  return list.filter((e) => e.type !== 'text' || !named.has(e.name)).slice(0, 80);
}

async function fillIn() {
  const answer = latestAnswer();
  if (filling || running || !answer || !settings.frameVisible) return;
  const controller = new AbortController();
  filling = controller;
  input.warmUp();
  tell('fill:state', { on: true });
  try {
    globalShortcut.register('Escape', () => controller.abort());
  } catch {
    // Esc is taken; the Stop button still works.
  }
  const providerId = settings.provider;
  const done = [];
  // Clicks must reach the page under the frame, not our own windows.
  const ours = [widget, timerWin].filter((win) => win && !win.isDestroyed() && win.isVisible());
  for (const win of overlays) win.setIgnoreMouseEvents(true);
  let error = null;
  try {
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
      const inTheWay = ours.filter((win) => overlapArea(win.getBounds(), rect) > 0);
      for (const win of inTheWay) {
        win.setOpacity(0);
        win.setIgnoreMouseEvents(true);
      }
      try {
        for (const action of plan.actions) {
          await perform(action, rect, elements, controller.signal);
          const target = action.target != null ? ` ${action.target + 1}` : '';
          done.push(`${action.type}${target}${action.text ? ` "${action.text}"` : ''}`);
        }
      } finally {
        for (const win of inTheWay) {
          if (win.isDestroyed()) continue;
          win.setIgnoreMouseEvents(false);
          win.setOpacity(1);
        }
      }
      if (!plan.look || !plan.actions.length) break;
      await wait(400); // let the page react before looking again
    }
  } catch (caught) {
    if (caught.code !== 'aborted' && !controller.signal.aborted) {
      error = caught instanceof AppError ? caught.message : `Couldn't fill it in: ${caught.message}`;
    }
  } finally {
    globalShortcut.unregister('Escape');
    for (const win of overlays) if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true });
    filling = null;
    tell('fill:state', { on: false, error, count: done.length });
    raiseFloating();
  }
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
  ipcMain.handle('model:download', (event, providerId, model) => {
    if (!fromWidget(event) || !PROVIDERS[providerId]) return { ok: false, error: 'Unknown provider.' };
    return startDownload(providerId, text(model, 300));
  });
  ipcMain.on('model:download-stop', (event) => fromWidget(event) && downloading && downloading.controller.abort());
  ipcMain.handle('update:check', (event) => (fromWidget(event) ? checkUpdate() : null));
  ipcMain.handle('update:install', (event) => (fromWidget(event) ? installUpdate() : null));
  ipcMain.on('copy', (event, value) => fromWidget(event) && clipboard.writeText(text(value, 200000)));
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
    if (win && !dragging && !selecting && !filling) win.setIgnoreMouseEvents(!!ignore, { forward: true });
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
