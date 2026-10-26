// Откуда виджет берёт обновления: GitHub Release с тегом `tag` в репозитории `repo`.
// Основной репозиторий публичный, поэтому токены не нужны: Actions кладёт exe в его Release `latest`.
module.exports = {
  repo: 'vladimirphoto/win-calendar-widge',
  tag: 'latest',
  asset: 'CalendarWidget.exe',            // portable-версия
  installerAsset: 'CalendarWidget-Setup.exe' // установленная версия
};
