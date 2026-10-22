// Короткое имя папки для строки состояния в приложении (F-25).
// Разделители `/` и `\` равноправны, пустые части (двойной слэш, слэш на конце) отбрасываются.
const partsOf = (path: string): string[] => path.split(/[\\/]+/).filter(part => part !== '')

// Правила (спека ctx 0.2.0, «Короткое имя папки»):
//  - папка равна домашней -> `~`;
//  - внутри домашней: две последние части пути от неё, а если после домашней одна часть -> `~/часть`;
//  - вне домашней (или домашняя неизвестна): две последние части, а если частей меньше двух -> путь целиком.
// Части склеиваются через `/`. Домашняя без частей (пусто, `/`) считается неизвестной: иначе любая
// папка выглядела бы «внутри» неё. Имя не обрезается: ширину ряда знает только приложение.
export function shortFolder(path: string, home: string | undefined): string {
  const parts = partsOf(path)
  const homeParts = home === undefined ? [] : partsOf(home)
  // Домашняя должна быть началом пути ПО ЧАСТЯМ, а не по строке: `/Users/annabelle` не внутри `/Users/anna`.
  const isInside = homeParts.length > 0 && homeParts.every((part, i) => parts[i] === part)
  if (isInside) {
    const below = parts.slice(homeParts.length)
    if (below.length === 0) return '~'
    if (below.length === 1) return `~/${below[0]}`
    return below.slice(-2).join('/')
  }
  if (parts.length >= 2) return parts.slice(-2).join('/')
  // Путь целиком: `/tmp`, `/`; ведущий разделитель сохраняется только у путей, которые с него начинались.
  return (/^[\\/]/.test(path) ? '/' : '') + parts.join('/')
}
