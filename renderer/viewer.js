// Shows one capture full size. Click anywhere or press Esc to close.
const bridge = window.viewerApi; // not "viewerApi": that name is taken on window
const image = document.getElementById('image');

bridge.onImage((src) => {
  image.onload = () => image.classList.add('ready');
  image.src = src;
});

document.addEventListener('click', () => bridge.close());
document.addEventListener('keydown', (event) => event.key === 'Escape' && bridge.close());
