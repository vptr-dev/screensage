// One of these covers each screen. It draws the frame, its toolbar and the
// shade, and lets every click through except on the handles and toolbar.
// While you move or resize the frame, this window draws it straight from the
// mouse (no round trip), and tells the main process so the other screens follow.

const bridge = window.overlayApi; // not "overlayApi": that name is taken on window
const root = document.documentElement;
const body = document.body;
const hole = document.getElementById('hole');
const bar = document.getElementById('bar');
const MIN = { width: 80, height: 48 };

let st = null; // the latest state from the main process
let local = null; // the rectangle this window is drawing right now (screen coordinates)
let drag = null; // moving or resizing
let draw = null; // drawing a new area
let ignoring = true;

function setIgnore(ignore) {
  if (ignore === ignoring) return;
  ignoring = ignore;
  bridge.setIgnore(ignore);
}

const point = (event) => ({ x: st.origin.x + event.clientX, y: st.origin.y + event.clientY });

function overlaps(rect) {
  return (
    rect.x < st.origin.x + st.size.width &&
    rect.x + rect.width > st.origin.x &&
    rect.y < st.origin.y + st.size.height &&
    rect.y + rect.height > st.origin.y
  );
}

function render() {
  if (!st) return;
  const rect = local || (st.selecting ? st.selection : st.hole);
  body.classList.toggle('on', st.visible);
  body.classList.toggle('selecting', st.selecting);
  body.classList.toggle('blank', st.selecting && !rect);
  body.classList.toggle('shade', st.selecting || st.shade);
  root.style.setProperty('--shade', String(st.selecting ? 0.38 : st.shadeStrength / 100));
  document.getElementById('shadeBtn').classList.toggle('on', st.shade);
  if (!rect) return;

  hole.style.left = `${rect.x - st.origin.x}px`;
  hole.style.top = `${rect.y - st.origin.y}px`;
  hole.style.width = `${rect.width}px`;
  hole.style.height = `${rect.height}px`;
  document.getElementById('size').textContent = `${rect.width} × ${rect.height}`;

  // The toolbar sits above the frame, or below it when there is no room above.
  const barHeight = 30;
  let x = rect.x;
  let y = rect.y - barHeight - 12;
  if (overlaps(rect)) {
    if (y < st.origin.y + 4) y = rect.y + rect.height + 12;
    x = Math.max(st.origin.x + 6, Math.min(x, st.origin.x + st.size.width - bar.offsetWidth - 6));
  }
  bar.style.left = `${x - st.origin.x}px`;
  bar.style.top = `${y - st.origin.y}px`;
}

bridge.onUpdate((state) => {
  st = state;
  if (!drag && !draw) local = null;
  render();
});

// Send the newest rectangle at most once per frame.
let queued = false;
function sendLater(send) {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (local) send(local);
  });
}

function resized(mode, start, dx, dy) {
  let { x, y, width, height } = start;
  if (mode === 'move') return { x: x + dx, y: y + dy, width, height };
  if (mode.includes('e')) width = Math.max(MIN.width, width + dx);
  if (mode.includes('s')) height = Math.max(MIN.height, height + dy);
  if (mode.includes('w')) {
    width = Math.max(MIN.width, start.width - dx);
    x = start.x + start.width - width;
  }
  if (mode.includes('n')) {
    height = Math.max(MIN.height, start.height - dy);
    y = start.y + start.height - height;
  }
  return { x, y, width, height };
}

document.addEventListener('mousemove', (event) => {
  if (!st || drag || draw || st.selecting) return;
  setIgnore(!event.target.closest('[data-mode], [data-action]'));
});

document.addEventListener('mouseleave', () => {
  if (!drag && !draw) setIgnore(true);
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (st && st.selecting) bridge.select(null, true); // right-click cancels drawing
});

document.addEventListener('pointerdown', (event) => {
  if (!st || event.button !== 0) return;
  if (st.selecting) {
    draw = point(event);
    body.setPointerCapture(event.pointerId);
    return;
  }
  if (event.target.closest('[data-action]')) return;
  const handle = event.target.closest('[data-mode]');
  if (!handle) return;
  drag = { mode: handle.dataset.mode, from: point(event), start: { ...st.hole } };
  body.classList.add('dragging');
  handle.setPointerCapture(event.pointerId);
});

document.addEventListener('pointermove', (event) => {
  if (drag) {
    const now = point(event);
    local = resized(drag.mode, drag.start, now.x - drag.from.x, now.y - drag.from.y);
    render();
    sendLater((rect) => bridge.rect(rect, false));
  } else if (draw) {
    const now = point(event);
    local = {
      x: Math.min(draw.x, now.x),
      y: Math.min(draw.y, now.y),
      width: Math.abs(now.x - draw.x),
      height: Math.abs(now.y - draw.y),
    };
    render();
    sendLater((rect) => bridge.select(rect, false));
  }
});

function finish() {
  if (drag) {
    const rect = local || drag.start;
    drag = null;
    body.classList.remove('dragging');
    bridge.rect(rect, true);
  } else if (draw) {
    const rect = local;
    draw = null;
    // A click without a real drag keeps the old area.
    bridge.select(rect && rect.width >= MIN.width && rect.height >= MIN.height ? rect : null, true);
  }
}

document.addEventListener('pointerup', finish);
document.addEventListener('pointercancel', finish);

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (button) bridge.action(button.dataset.action);
});
