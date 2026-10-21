// Откуда виджет берёт обновления: GitHub Release с тегом `tag` в репозитории `repo`.
// Это отдельный ПУБЛИЧНЫЙ репозиторий только с готовыми exe (исходного кода в нём нет),
// сюда релизы публикует GitHub Actions из приватного репозитория с кодом.
module.exports = {
  repo: 'vladimirphoto/win-calendar-widget-releases',
  tag: 'latest',
  asset: 'CalendarWidget.exe'
};
