function pad(value) {
  return String(value).padStart(2, "0");
}

function localDateValue(date) {
  var value = date || new Date();
  return value.getFullYear() + "-" + pad(value.getMonth() + 1) + "-" + pad(value.getDate());
}

function monthValue(date) {
  var value = date || new Date();
  return value.getFullYear() + "-" + pad(value.getMonth() + 1);
}

function monthRange(month) {
  var parts = month.split("-").map(Number);
  var lastDay = new Date(parts[0], parts[1], 0).getDate();
  return { from: month + "-01", to: month + "-" + pad(lastDay) };
}

function shiftMonth(month, offset) {
  var parts = month.split("-").map(Number);
  var shifted = new Date(parts[0], parts[1] - 1 + offset, 1);
  return monthValue(shifted);
}

function buildCalendarCells(month, recordedDays) {
  var parts = month.split("-").map(Number);
  var firstWeekday = new Date(parts[0], parts[1] - 1, 1).getDay();
  var records = {};
  (recordedDays || []).forEach(function (item) {
    records[item.localDate] = item;
  });
  return Array.from({ length: 42 }, function (_, index) {
    var date = new Date(parts[0], parts[1] - 1, index - firstWeekday + 1);
    var dateValue = localDateValue(date);
    var record = records[dateValue] || null;
    var total = record ? record.tnssTotal : null;
    var severity = !record || !record.symptomId
      ? ""
      : total <= 0 ? "good" : total <= 4 ? "mild" : total <= 8 ? "moderate" : "severe";
    return {
      date: dateValue,
      day: date.getDate(),
      muted: date.getMonth() !== parts[1] - 1,
      today: dateValue === localDateValue(),
      hasSymptom: Boolean(record && record.symptomId),
      tnssTotal: total,
      severity: severity
    };
  });
}

module.exports = {
  buildCalendarCells: buildCalendarCells,
  localDateValue: localDateValue,
  monthRange: monthRange,
  monthValue: monthValue,
  shiftMonth: shiftMonth
};
