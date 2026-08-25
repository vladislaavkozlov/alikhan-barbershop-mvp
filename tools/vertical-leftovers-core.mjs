// Общий счётчик барбершопных слов в исходниках - одно правило на сито №1
// (tests/vertical-leftovers.test.js) и на список работ
// (tools/list-vertical-leftovers.mjs). Два счётчика разошлись бы на первой же правке.
//
// Считается только то, что видит человек. Не считаются:
//   - комментарии, и построчные, и блочные, и HTML-овские (их читает разработчик);
//   - строка с data-term / data-phrase / data-term-attr - там барбершопное слово
//     написано осознанно, как запасной вариант на случай незагруженного словаря;
//   - строка с вызовом T( / Tc( / P( / C( - слово уже берётся из словаря;
//   - технические строки: импорты, экспорты, адреса файлов;
//   - строка с пометкой «не интерфейс:» и объяснением - там барбершопное слово это
//     данные (названия услуг демо-макета, ключи справочников), а не надпись. Пометка
//     обязана нести причину, иначе ею закроют настоящий пропуск.
export const ROOTS = /мастер|запис|услуг|клиент|салон|стрижк|барбершоп/i;
const EXCUSED = /data-term|data-phrase|data-term-attr|\bT\(|\bTc\(|\bP\(|\bC\(/;
const TECHNICAL = /^\s*(?:import|export)\b|\.js['"]/;

// Пометка ставится комментарием на самой строке: `// не интерфейс: <причина>`
const NOT_UI_MARK = /(?:\/\/|\/\*|<!--)\s*не интерфейс:\s*\S/;

export function leftoverLines(source) {
  const out = [];
  let inBlock = false;
  let inHtml = false;
  source.split('\n').forEach((line, index) => {
    if (NOT_UI_MARK.test(line)) return;
    let text = line;
    if (inHtml) {
      const close = text.indexOf('-->');
      if (close === -1) return;
      text = text.slice(close + 3);
      inHtml = false;
    }
    if (inBlock) {
      const close = text.indexOf('*/');
      if (close === -1) return;
      text = text.slice(close + 2);
      inBlock = false;
    }
    // Комментарий, открытый и не закрытый на этой строке: хвост уходит в следующие
    const htmlOpen = text.lastIndexOf('<!--');
    if (htmlOpen !== -1 && text.indexOf('-->', htmlOpen) === -1) {
      inHtml = true;
      text = text.slice(0, htmlOpen);
    }
    const blockOpen = text.lastIndexOf('/*');
    if (blockOpen !== -1 && text.indexOf('*/', blockOpen) === -1) {
      inBlock = true;
      text = text.slice(0, blockOpen);
    }
    // Однострочные: `// …` и целиком закрытые `<!-- … -->` / `/* … */`
    text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const lineComment = text.indexOf('//');
    if (lineComment !== -1 && !/https?:$/.test(text.slice(0, lineComment))) text = text.slice(0, lineComment);
    if (!ROOTS.test(text)) return;
    if (EXCUSED.test(text)) return;
    if (TECHNICAL.test(text)) return;
    out.push({ line: index + 1, text: line.trim() });
  });
  return out;
}
