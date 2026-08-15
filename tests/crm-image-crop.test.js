// Кадрирование фото профиля (просьба Влада 15.08.2026 - «отцентровать фото, как в
// телеграме или вк»). Здесь проверяется расчёт кадра: какой именно квадрат исходного
// файла попадёт в аватар при данном приближении и сдвиге. Само окно (перетаскивание,
// ползунок, щипок) - живой прогон tools/verify-2026-08-15-kadrirovanie-foto.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

const { sourceSquare } = await import('../assets/crm-image-crop.js');

const STAGE = 300;
// Приближение 1 = фото ровно закрывает квадратную область («cover»)
const coverScale = (image) => Math.max(STAGE / image.naturalWidth, STAGE / image.naturalHeight);

test('без сдвига берётся центральный квадрат - у горизонтального фото по ширине', () => {
  const image = { naturalWidth: 2000, naturalHeight: 1000 };
  const square = sourceSquare(image, STAGE, coverScale(image), 0, 0);
  assert.deepEqual(square, { x: 500, y: 0, side: 1000 });
});

test('без сдвига у вертикального фото квадрат берётся по высоте', () => {
  const image = { naturalWidth: 1080, naturalHeight: 1920 };
  const square = sourceSquare(image, STAGE, coverScale(image), 0, 0);
  assert.equal(square.side, 1080);
  assert.equal(square.x, 0);
  assert.equal(square.y, (1920 - 1080) / 2);
});

test('сдвиг фото вправо показывает его левую часть', () => {
  const image = { naturalWidth: 2000, naturalHeight: 1000 };
  const scale = coverScale(image); // 0.3
  const moved = sourceSquare(image, STAGE, scale, 30, 0);
  // 30 экранных точек при уменьшении 0.3 - это 100 точек исходника
  assert.equal(moved.x, 400);
  assert.equal(moved.y, 0);
});

test('сдвиг вверх поднимает кадр - именно так спасают срезанное лицо', () => {
  const image = { naturalWidth: 1080, naturalHeight: 1920 };
  const scale = coverScale(image);
  const centered = sourceSquare(image, STAGE, scale, 0, 0);
  const lifted = sourceSquare(image, STAGE, scale, 0, 60);
  assert.ok(lifted.y < centered.y, 'кадр должен уехать выше по исходнику');
  assert.equal(centered.y - lifted.y, 60 / scale);
});

test('приближение уменьшает кадр вокруг того же центра', () => {
  const image = { naturalWidth: 1200, naturalHeight: 1200 };
  const scale = coverScale(image);
  const near = sourceSquare(image, STAGE, scale * 2, 0, 0);
  assert.equal(near.side, 600);
  assert.equal(near.x, 300);
  assert.equal(near.y, 300);
});

test('кадр никогда не выходит за края файла при допустимом сдвиге', () => {
  const image = { naturalWidth: 1600, naturalHeight: 900 };
  const scale = coverScale(image);
  // Предельный сдвиг по правилу окна: (ширина на экране - сторона области) / 2
  const room = (image.naturalWidth * scale - STAGE) / 2;
  for (const offset of [-room, -room / 2, 0, room / 2, room]) {
    const square = sourceSquare(image, STAGE, scale, offset, 0);
    assert.ok(square.x >= -1e-9, `левый край уехал за файл: ${square.x}`);
    assert.ok(square.x + square.side <= image.naturalWidth + 1e-9, `правый край уехал за файл: ${square.x + square.side}`);
  }
});
