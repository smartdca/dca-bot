// 某個時區的「今天」，格式 YYYY-MM-DD
export function dayIn(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
