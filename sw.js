// Фоновый обработчик уведомлений (Окно 73, 28.08.2026).
//
// Этот файл - единственная часть сайта, которая работает, когда вкладка закрыта,
// а телефон лежит в кармане. Браузер держит его отдельно от страниц и будит,
// когда приходит уведомление от нашего сервера.
//
// Намеренно НЕ кэширует страницы. Соблазн сделать здесь офлайн-режим большой, но
// кэш в служебном обработчике - самая частая причина «у меня старая версия и она
// не обновляется» на живом проекте. Задача этого файла ровно одна: показать
// уведомление и открыть нужный кабинет по нажатию.

// Новая версия обработчика вступает в силу сразу, не дожидаясь, пока человек
// закроет все вкладки. Иначе после обновления сайта уведомления какое-то время
// обрабатывала бы старая копия.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Содержимое не разобралось - показываем хотя бы факт события, молчать хуже
    data = { title: 'Алихан CRM', body: 'Новое уведомление' };
  }

  const title = data.title || 'Алихан CRM';
  const options = {
    body: data.body || '',
    icon: 'assets/brand/icon-192.png',
    badge: 'assets/brand/icon-192.png',
    // Вибрация коротким двойным сигналом: телефон в кармане мастера должен быть
    // различим на слух и на ощупь, но не как звонок
    vibrate: [80, 40, 80],
    data: { url: data.url || '' },
    // Уведомления по одному и тому же событию схлопываются в одно, а не копятся
    // стопкой: тег общий, если сервер не прислал свой
    tag: data.tag || 'alikhan-crm',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Кабинет уже открыт где-то - переводим фокус туда, а не плодим вкладки
    for (const client of all) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow(target || './');
    }
    return undefined;
  })());
});
