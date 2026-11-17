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
  onReset: on('reset'),
});

// The frame overlays.
contextBridge.exposeInMainWorld('overlayApi', {
  onUpdate: on('overlay'),
  setIgnore: send('overlay:ignore'),
  rect: send('overlay:rect'),
  select: send('overlay:select'),
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
