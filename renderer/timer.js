// A minimal countdown. Set it to 0:00 and press play to count up instead.
// Click the time to type one ("5", "1:30", "1:00:00"); scroll a number to nudge it.

const bridge = window.timerApi; // not "timerApi": that name is taken on window
const $ = (id) => document.getElementById(id);
const body = document.body;

let duration = 300; // seconds the countdown starts from
let remaining = duration * 1000; // ms left (counting down)
let elapsed = 0; // ms counted (counting up)
let mode = 'down';
let running = false;
let endsAt = 0;
let startedAt = 0;
let ticker = null;
let audio = null;

const pad = (n) => String(n).padStart(2, '0');

function showTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000 - 0.001));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  $('hours').hidden = $('hoursColon').hidden = h === 0;
  $('hours').textContent = String(h);
  $('minutes').textContent = pad(m);
  $('seconds').textContent = pad(s);
}

function paint() {
  const ms = mode === 'up' ? elapsed : remaining;
  showTime(mode === 'up' ? ms + 999 : ms);
  const counting = mode === 'down' && (running || remaining < duration * 1000) && duration > 0;
  body.classList.toggle('counting', counting);
  body.classList.toggle('running', running);
  body.classList.toggle('paused', !running && (mode === 'up' ? elapsed > 0 : remaining < duration * 1000) && remaining > 0);
  body.classList.toggle('idle', !running && !body.classList.contains('done'));
  if (counting) $('progress').style.transform = `scaleX(${duration ? remaining / (duration * 1000) : 0})`;
  $('play').title = running ? 'Pause' : 'Start';
}

function tick() {
  const now = Date.now();
  if (mode === 'up') {
    elapsed = now - startedAt;
  } else {
    remaining = Math.max(0, endsAt - now);
    if (remaining === 0) {
      stop();
      body.classList.add('done');
      chime();
    }
  }
  paint();
}

function start() {
  if (body.classList.contains('done')) reset();
  if (duration === 0 && mode === 'down' && remaining === 0) mode = 'up';
  if (mode === 'up') startedAt = Date.now() - elapsed;
  else endsAt = Date.now() + remaining;
  running = true;
  ticker = setInterval(tick, 200);
  ensureAudio();
  paint();
}

function stop() {
  running = false;
  clearInterval(ticker);
  ticker = null;
}

function reset() {
  stop();
  body.classList.remove('done');
  mode = duration === 0 ? 'up' : 'down';
  remaining = duration * 1000;
  elapsed = 0;
  paint();
}

function setDuration(seconds) {
  duration = Math.max(0, Math.min(359999, Math.round(seconds)));
  bridge.save(duration);
  reset();
}

// ---------- sound ----------

function ensureAudio() {
  if (!audio) audio = new AudioContext();
}

/** A soft two-note chime, played twice. */
function chime() {
  ensureAudio();
  const now = audio.currentTime;
  [0, 0.5].forEach((offset) => {
    [880, 1318.5].forEach((frequency, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const at = now + offset + i * 0.14;
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 1);
    });
  });
}

// ---------- buttons ----------

$('play').addEventListener('click', () => (running ? (stop(), paint()) : start()));
$('reset').addEventListener('click', reset);
$('close').addEventListener('click', () => bridge.close());

// ---------- setting the time ----------

function parseTime(input) {
  const parts = input.trim().split(/[:.\s]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 1) return parts[0] * 60; // a single number means minutes
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function format(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function startEditing() {
  if (running) return;
  bridge.focus();
  $('clock').hidden = true;
  $('edit').hidden = false;
  $('edit').value = format(duration);
  $('edit').focus();
  $('edit').select();
}

function stopEditing(apply) {
  if ($('edit').hidden) return;
  const seconds = apply ? parseTime($('edit').value) : null;
  $('edit').hidden = true;
  $('clock').hidden = false;
  if (seconds !== null) setDuration(seconds);
}

$('edit').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') stopEditing(true);
  if (event.key === 'Escape') stopEditing(false);
});
$('edit').addEventListener('blur', () => stopEditing(true));

$('clock').addEventListener(
  'wheel',
  (event) => {
    if (running) return;
    const unit = event.target.dataset && event.target.dataset.unit;
    if (!unit) return;
    event.preventDefault();
    const step = { h: 3600, m: 60, s: 5 }[unit] * (event.deltaY < 0 ? 1 : -1);
    setDuration(duration + step);
  },
  { passive: false },
);

// ---------- moving the timer ----------
// Grab it anywhere except the buttons. A press without moving on the time edits it.

let press = null;

document.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button, input')) return;
  press = { x: event.screenX, y: event.screenY, dragging: false, onClock: !!event.target.closest('#clock') };
  document.documentElement.setPointerCapture?.(event.pointerId);
});

document.addEventListener('pointermove', (event) => {
  if (!press || press.dragging) return;
  if (Math.abs(event.screenX - press.x) + Math.abs(event.screenY - press.y) > 3) {
    press.dragging = true;
    body.classList.add('dragging');
    bridge.dragStart();
  }
});

document.addEventListener('pointerup', () => {
  if (!press) return;
  if (press.dragging) {
    bridge.dragEnd();
    body.classList.remove('dragging');
  } else if (press.onClock) {
    if (body.classList.contains('done')) reset();
    else startEditing();
  }
  press = null;
});

// ---------- start ----------

bridge.state().then((state) => {
  duration = state.prefs.timer.seconds;
  reset();
});
paint();
