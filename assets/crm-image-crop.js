// Кадрирование фото профиля перед загрузкой (просьба Влада 15.08.2026: «при
// добавлении фото профиля нужно сделать возможность её отцентровать, как в
// телеграме или вк»).
//
// Раньше файл уходил на сервер как есть: sharp вписывал его в 1800px, а кружок
// аватара показывал центр исходника - лицо на вертикальном фото с телефона
// оказывалось срезанным сверху, и поправить это было нечем.
//
// Здесь человек сам выбирает, какой квадрат станет аватаром: фото двигается пальцем
// или мышью, приближается ползунком, колесом и щипком. Наружу отдаётся готовый
// квадратный файл - сервер и остальной интерфейс не меняются вовсе, они по-прежнему
// получают обычную картинку.
const OUTPUT_MAX = 1024; // сторона готового квадрата, апскейл маленьких фото не делаем
const ZOOM_MAX = 4;

const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, revoke: () => URL.revokeObjectURL(url) });
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('invalid_image')); };
    image.src = url;
  });
}

function buildDialog(fileName) {
  const overlay = document.createElement('div');
  overlay.className = 'crop-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Кадрирование фото профиля');
  overlay.innerHTML = `
    <div class="crop-card">
      <div class="crop-head">
        <h3>Фото профиля</h3>
        <p>Двигайте фото и приближайте - в кружок попадёт то, что видно внутри круга</p>
      </div>
      <div class="crop-stage" data-crop-stage>
        <img alt="" draggable="false" data-crop-image>
        <div class="crop-mask" aria-hidden="true"></div>
      </div>
      <div class="crop-zoom">
        <span class="crop-zoom-icon" aria-hidden="true">−</span>
        <input type="range" min="1" max="${ZOOM_MAX}" step="0.01" value="1" data-crop-zoom aria-label="Приближение">
        <span class="crop-zoom-icon" aria-hidden="true">+</span>
      </div>
      <p class="crop-file">${esc(fileName)}</p>
      <div class="crop-actions">
        <button class="btn btn-ghost" type="button" data-crop-cancel>Отмена</button>
        <button class="btn btn-primary" type="button" data-crop-save>Поставить фото</button>
      </div>
    </div>`;
  document.body.append(overlay);
  return overlay;
}

// Квадрат, который человек видит внутри круга, в координатах ИСХОДНОГО файла.
// scale - во сколько раз фото уменьшено на экране, offset - сдвиг центра фото
// относительно центра области (в экранных пикселях)
function sourceSquare({ naturalWidth, naturalHeight }, stage, scale, offsetX, offsetY) {
  const side = stage / scale;
  const centerX = naturalWidth / 2 - offsetX / scale;
  const centerY = naturalHeight / 2 - offsetY / scale;
  return { x: centerX - side / 2, y: centerY - side / 2, side };
}

/**
 * Показывает окно кадрирования и возвращает квадратный файл (или null, если человек
 * отказался). Ошибку чтения файла отдаёт исключением - вызывающий код решает, как
 * про неё сказать
 */
export async function cropSquareImage(file) {
  const { image, revoke } = await loadImage(file);
  const overlay = buildDialog(file.name);
  const stageEl = overlay.querySelector('[data-crop-stage]');
  const imageEl = overlay.querySelector('[data-crop-image]');
  const zoomEl = overlay.querySelector('[data-crop-zoom]');
  imageEl.src = image.src;

  let stage = stageEl.getBoundingClientRect().width || 280;
  // «Cover»: при zoom=1 фото ровно закрывает область, пустых полей в кружке не бывает
  const baseScale = () => Math.max(stage / image.naturalWidth, stage / image.naturalHeight);
  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;

  function limit(value, axis) {
    const scale = baseScale() * zoom;
    const size = (axis === 'x' ? image.naturalWidth : image.naturalHeight) * scale;
    const room = Math.max(0, (size - stage) / 2);
    return Math.min(room, Math.max(-room, value));
  }

  function draw() {
    const scale = baseScale() * zoom;
    offsetX = limit(offsetX, 'x');
    offsetY = limit(offsetY, 'y');
    imageEl.style.width = `${image.naturalWidth * scale}px`;
    imageEl.style.height = `${image.naturalHeight * scale}px`;
    imageEl.style.transform = `translate(-50%, -50%) translate(${offsetX}px, ${offsetY}px)`;
  }

  function setZoom(next) {
    const clamped = Math.min(ZOOM_MAX, Math.max(1, next));
    // Приближаем к центру круга: то, что человек поставил в центр, там и остаётся
    const factor = clamped / zoom;
    offsetX *= factor;
    offsetY *= factor;
    zoom = clamped;
    zoomEl.value = String(zoom);
    draw();
  }

  const pointers = new Map();
  let pinchDistance = 0;

  const onPointerDown = (event) => {
    stageEl.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0 && distance > 0) setZoom(zoom * (distance / pinchDistance));
      pinchDistance = distance;
      return;
    }
    offsetX += event.clientX - previous.x;
    offsetY += event.clientY - previous.y;
    draw();
  };
  const onPointerUp = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
  };
  const onWheel = (event) => {
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
  };
  const onResize = () => {
    const next = stageEl.getBoundingClientRect().width;
    if (!next || next === stage) return;
    const ratio = next / stage;
    stage = next;
    offsetX *= ratio;
    offsetY *= ratio;
    draw();
  };

  stageEl.addEventListener('pointerdown', onPointerDown);
  stageEl.addEventListener('pointermove', onPointerMove);
  stageEl.addEventListener('pointerup', onPointerUp);
  stageEl.addEventListener('pointercancel', onPointerUp);
  stageEl.addEventListener('wheel', onWheel, { passive: false });
  zoomEl.addEventListener('input', () => setZoom(Number(zoomEl.value)));
  window.addEventListener('resize', onResize);

  draw();

  return new Promise((resolve) => {
    function finish(result) {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      revoke();
      resolve(result);
    }
    function onKey(event) {
      if (event.key === 'Escape') finish(null);
    }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(null); });
    overlay.querySelector('[data-crop-cancel]').addEventListener('click', () => finish(null));
    overlay.querySelector('[data-crop-save]').addEventListener('click', () => {
      const square = sourceSquare(image, stage, baseScale() * zoom, offsetX, offsetY);
      const side = Math.min(OUTPUT_MAX, Math.round(square.side));
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, square.x, square.y, square.side, square.side, 0, 0, side, side);
      canvas.toBlob((blob) => {
        if (!blob) return finish(null);
        const name = file.name.replace(/\.[^.]+$/, '') || 'avatar';
        finish(new File([blob], `${name}.jpg`, { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.92);
    });
  });
}

// Отдельно от диалога - чтобы расчёт кадра можно было проверить офлайн-тестом
export { sourceSquare };
