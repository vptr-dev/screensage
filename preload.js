const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => ipcRenderer.on(channel, (_event, payload) => handler(payload));
const send = (channel) => (...args) => ipcRenderer.send(channel, ...args);
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

// The widget.
contextBridge.exposeInMainWorld('sage', {
  state: invoke('state'),
  setProvider: invoke('provider:set'),
  setModel: invoke('model:set'),
  setKey: invoke('key:set'),
  setBaseUrl: invoke('baseurl:set'),
  listModels: invoke('models:list'),
  setPref: invoke('prefs:set'),
  history: invoke('history:list'),
  deleteHistory: invoke('history:delete'),
  storage: invoke('storage:info'),
  clearRecents: invoke('storage:clear-recents'),
  deleteAll: invoke('storage:delete-all'),
  openKeyPage: send('key:open-page'),
  ask: send('ask'),
  retry: send('retry'),
  followUp: send('followup'),
  stop: send('stop'),
  fill: send('fill'),
  setSteps: invoke('steps:set'),
  pickSpot: invoke('steps:pick'),
  runSteps: send('steps:run'),
  onAuto: on('auto:state'),
  onWait: on('auto:wait'),
  onVerdict: on('auto:verdict'),
  onSpeak: on('speak'),
  download: invoke('model:download'),
  stopDownload: send('model:download-stop'),
  onDownload: on('download:progress'),
  checkUpdate: invoke('update:check'),
  installUpdate: invoke('update:install'),
  onUpdate: on('update:progress'),
  copy: send('copy'),
  openImage: send('image:open'),
  toggleFrame: send('frame:toggle'),
  selectArea: send('frame:select'),
  toggleTimer: send('timer:toggle'),
  resetPositions: send('positions:reset'),
  setHeight: send('widget:height'),
  close: send('window:close'),
  onState: on('state'),
  onStart: on('answer:start'),
  onChunk: on('answer:chunk'),
  onThinking: on('answer:thinking'),
  onDone: on('answer:done'),
  onError: on('answer:error'),
  onFollowUp: on('answer:followup'),
  onRetry: on('answer:retry'),
  onRethink: on('answer:rethink'),
  onReplace: on('answer:replace'),
  onToast: on('toast'),
  onReset: on('reset'),
});

// The frame overlays.
contextBridge.exposeInMainWorld('overlayApi', {
  onUpdate: on('overlay'),
  setIgnore: send('overlay:ignore'),
  rect: send('overlay:rect'),
  select: send('overlay:select'),
  pick: send('overlay:pick'),
  action: send('overlay:action'),
});

// The timer.
contextBridge.exposeInMainWorld('timerApi', {
  state: invoke('state'),
  save: (seconds) => ipcRenderer.invoke('prefs:set', 'timer', { seconds }),
  close: send('timer:close'),
  focus: send('timer:focus'),
  dragStart: send('timer:drag-start'),
  dragEnd: send('timer:drag-end'),
});

// The image viewer.
contextBridge.exposeInMainWorld('viewerApi', {
  onImage: on('viewer:image'),
  close: send('viewer:close'),
});
