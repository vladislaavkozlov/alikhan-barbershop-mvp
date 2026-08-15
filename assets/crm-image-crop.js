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
      <!-- Пояснение под заголовком убрано по просьбе Влада 15.08.2026: круг и
           ползунок объясняют себя сами, а текст занимал место, особенно на телефоне -->
      <div class="crop-head">
        <h3>Фото профиля</h3>
      </div>
      <div class="crop-stage" data-crop-stage>
        <img alt="" draggable="false" data-crop-image>
        <div class="crop-mask" aria-hidden="true"></div>
      </div>
      <div class="crop-zoom">
        <span class="crop-zoom-icon" aria-hidden="true">−</span>
        <!-- step="any": сетка шагов у range отсчитывается от min, а min здесь зависит
             от пропорций фото - при фиксированном шаге стартовое значение съезжало бы
             с ровной единицы («фото ровно закрывает кадр») на 1.001 и подобное -->
        <input type="range" min="1" max="${ZOOM_MAX}" step="any" value="1" data-crop-zoom aria-label="Приближение и отдаление">
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

// Насколько сильно можно отдалить фото, считая от «cover» (zoom = 1). Граница - когда
// вся картинка целиком помещается в КРУГ: диагональ фото равна диаметру круга. Дальше
// отдалять нечего, фото и так видно полностью. Совсем длинные панорамы упёрлись бы в
// исчезающе мелкий масштаб, поэтому ниже 0.3 не опускаемся
export function minZoomFor({ naturalWidth, naturalHeight }) {
  const fitInCircle = Math.min(naturalWidth, naturalHeight) / Math.hypot(naturalWidth, naturalHeight);
  return Math.max(0.3, Number(fitInCircle.toFixed(3)));
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
  // Правка Влада 15.08.2026: «зум есть, а отдалить нельзя». Нижняя граница - когда всё
  // фото целиком помещается ВНУТРЬ круга (не квадрата: аватар круглый, углы квадрата
  // всё равно срезаются). Дальше отдалять смысла нет - фото уже видно полностью
  const minZoom = () => minZoomFor(image);
  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;
  zoomEl.min = String(minZoom());

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
    const clamped = Math.min(ZOOM_MAX, Math.max(minZoom(), next));
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
      // Фото отдалили сильнее, чем нужно для заполнения кадра - по краям остались
      // пустые поля. JPEG залил бы их чёрным, поэтому такой кадр сохраняем PNG: поля
      // остаются прозрачными, и в кружке сквозь них виден фон интерфейса. Кадр без
      // полей (обычный случай) по-прежнему JPEG - он заметно легче при отправке
      const hasEmptyEdges =
        square.x < -0.5 || square.y < -0.5 ||
        square.x + square.side > image.naturalWidth + 0.5 ||
        square.y + square.side > image.naturalHeight + 0.5;
      const type = hasEmptyEdges ? 'image/png' : 'image/jpeg';
      canvas.toBlob((blob) => {
        if (!blob) return finish(null);
        const name = file.name.replace(/\.[^.]+$/, '') || 'avatar';
        finish(new File([blob], `${name}.${hasEmptyEdges ? 'png' : 'jpg'}`, { type }));
      }, type, 0.92);
    });
  });
}

// Отдельно от диалога - чтобы расчёт кадра можно было проверить офлайн-тестом
export { sourceSquare };
