function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireDate(value, label = 'Ngày') {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw httpError(400, `${label} phải có định dạng YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw httpError(400, `${label} không phải ngày hợp lệ`);
  }
  return text;
}

function requirePositiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw httpError(400, `${label} không hợp lệ`);
  }
  return parsed;
}

function sqlDateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return requireDate(value);
}

module.exports = { httpError, requireDate, requirePositiveId, sqlDateKey };
