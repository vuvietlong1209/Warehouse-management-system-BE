const ExcelJS = require('exceljs');

const font = { name: 'Times New Roman', size: 10, color: { argb: 'FF000000' } };
const border = Object.fromEntries(['top', 'bottom', 'left', 'right'].map(edge => [edge, { style: 'thin', color: { argb: 'FFD9D9D9' } }]));
const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
const numericDisplay = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

// Excel does not auto-fit wrapped row heights when opening a generated workbook.
function textLines(text, width) {
  const capacity = Math.max(4, Math.floor(width * 1.15));
  return String(text).split('\n').reduce((sum, line) => {
    let lines = 1, used = 0;
    for (const word of line.split(/\s+/)) {
      if (used && used + word.length + 1 > capacity) { lines += 1; used = 0; }
      lines += Math.max(0, Math.ceil(word.length / capacity) - 1);
      used = (used ? used + 1 : 0) + (word.length ? (word.length - 1) % capacity + 1 : 0);
    }
    return sum + lines;
  }, 0);
}

async function renderExcel(snapshot, { signatures, period, display }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Hệ thống quản lý kho';
  workbook.title = snapshot.title;
  workbook.created = new Date(snapshot.createdAt);
  workbook.modified = new Date(snapshot.createdAt);
  const landscape = ['NXT', 'COGS'].includes(snapshot.reportType);
  const sheet = workbook.addWorksheet('Báo cáo', {
    properties: { defaultRowHeight: 24 },
    pageSetup: { paperSize: snapshot.paperSize === 'A5' ? 11 : 9, orientation: landscape ? 'landscape' : 'portrait',
      fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
      margins: { left: .35, right: .35, top: .4, bottom: .4, header: .15, footer: .2 } },
  });
  sheet.headerFooter.oddFooter = '&R&"Times New Roman"&9Trang &P / &N';
  const count = snapshot.columns.length;
  const weight = snapshot.columns.reduce((sum, column) => sum + column.width, 0);
  const widths = snapshot.columns.map(column => Math.max(column.label === 'Ngày' ? 14 : 7, column.width / weight * (landscape ? 160 : 108)));
  for (const row of [...snapshot.rows, ...snapshot.totals]) row.forEach((value, index) => {
    if (typeof value === 'number') widths[index] = Math.max(widths[index], numericDisplay.format(value).length * .85 + 2);
  });
  sheet.columns = widths.map(width => ({ width }));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  const merged = (row, first, last, value, options = {}) => {
    if (first < last) sheet.mergeCells(row, first, row, last);
    const cell = sheet.getCell(row, first);
    cell.value = value;
    cell.font = { ...font, ...options.font };
    cell.alignment = { vertical: 'middle', wrapText: true, ...options.alignment };
    return cell;
  };
  const metadataSplit = Math.max(1, count - 2);
  merged(1, 1, metadataSplit, 'ĐƠN VỊ: QUẢN LÝ KHO & THEO DÕI TỒN KHO', { font: { bold: true } });
  merged(1, metadataSplit + 1, count, `Mẫu số: ${snapshot.formCode}`, { font: { bold: true }, alignment: { horizontal: 'right' } });
  sheet.getRow(1).height = Math.max(24, textLines('ĐƠN VỊ: QUẢN LÝ KHO & THEO DÕI TỒN KHO', widths.slice(0, metadataSplit).reduce((sum, width) => sum + width, 0)) * 14 + 8);
  merged(2, 1, metadataSplit, 'Bộ phận: Quản lý hàng tồn kho');
  merged(2, metadataSplit + 1, count, 'Báo cáo quản trị nội bộ', { font: { italic: true }, alignment: { horizontal: 'right' } });
  sheet.getRow(2).height = 24;
  sheet.getRow(3).height = 8;
  merged(4, 1, count, snapshot.title, { font: { size: 14, bold: true }, alignment: { horizontal: 'center' } });
  sheet.getRow(4).height = 30;
  merged(5, 1, count, period(snapshot), { font: { italic: true }, alignment: { horizontal: 'center' } });
  sheet.getRow(5).height = 22;
  merged(6, 1, count, `Kho: ${snapshot.warehouseName}`);
  sheet.getRow(6).height = Math.max(22, textLines(`Kho: ${snapshot.warehouseName}`, totalWidth) * 14 + 8);
  const created = new Date(snapshot.createdAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
  merged(7, 1, count, `Ngày lập: ${created}`, { alignment: { horizontal: 'right' } });
  let headerRow = 9;
  if (snapshot.search) {
    merged(8, 1, count, `Từ khóa: ${snapshot.search}`);
    sheet.getRow(8).height = Math.max(22, textLines(`Từ khóa: ${snapshot.search}`, totalWidth) * 14 + 8);
    headerRow += 1;
  }
  sheet.getRow(headerRow - 1).height = 8;
  const writeRow = (rowNumber, values, header = false, total = false) => {
    let span = 1;
    if (total) while (span < count && values[span] === '') span += 1;
    if (span > 1) sheet.mergeCells(rowNumber, 1, rowNumber, span);
    let height = 26;
    values.forEach((value, index) => {
      if (index > 0 && index < span) return;
      const cell = sheet.getCell(rowNumber, index + 1);
      // Preserve numeric cells for Excel calculations; strings never become formulas.
      cell.value = typeof value === 'number' ? value : display(value, snapshot.fromDate);
      cell.font = { ...font, bold: header || total };
      const numeric = typeof value === 'number';
      cell.alignment = { vertical: 'middle', horizontal: header ? 'center' : total && index === 0 ? 'left' : index === 0 ? 'center' : snapshot.columns[index].align,
        wrapText: !numeric };
      cell.border = border;
      if (header || total) cell.fill = fill;
      if (numeric) cell.numFmt = Number.isInteger(value) ? '#,##0' : '#,##0.00';
      if (!header && !total && snapshot.columns[index].label === 'Ngày' && typeof value === 'string') {
        const parts = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(value);
        if (parts) {
          const year = parts[3].length === 4 ? Number(parts[3]) : Math.floor(Number(snapshot.fromDate.slice(0, 4)) / 100) * 100 + Number(parts[3]);
          const parsed = new Date(Date.UTC(year, Number(parts[2]) - 1, Number(parts[1])));
          if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === Number(parts[2]) - 1 && parsed.getUTCDate() === Number(parts[1])) {
            cell.value = parsed;
            cell.numFmt = 'dd/mm/yyyy';
            cell.alignment.wrapText = false;
          }
        }
      }
      const width = index === 0 && span > 1 ? widths.slice(0, span).reduce((sum, width) => sum + width, 0) : widths[index];
      if (!numeric && !(cell.value instanceof Date)) height = Math.max(height, textLines(cell.value, width - 1) * 14 + 10);
    });
    sheet.getRow(rowNumber).height = height;
  };
  writeRow(headerRow, snapshot.columns.map(column => column.label), true);
  let nextRow = headerRow + 1;
  if (!snapshot.rows.length) {
    merged(nextRow++, 1, count, 'Không có dữ liệu phù hợp', { alignment: { horizontal: 'center' } }).border = border;
    sheet.getRow(nextRow - 1).height = 30;
  }
  snapshot.rows.forEach(row => writeRow(nextRow++, row));
  snapshot.totals.forEach(row => writeRow(nextRow++, row, false, true));
  sheet.getRow(nextRow++).height = 18;
  // Divide the existing column grid as evenly as possible into four signing areas.
  const cuts = [0];
  for (let group = 1; group < signatures.length; group += 1) {
    let best = cuts[group - 1] + 1;
    for (let cut = best; cut <= count - (signatures.length - group); cut += 1) {
      if (Math.abs(widths.slice(0, cut).reduce((sum, width) => sum + width, 0) - totalWidth * group / 4)
        < Math.abs(widths.slice(0, best).reduce((sum, width) => sum + width, 0) - totalWidth * group / 4)) best = cut;
    }
    cuts.push(best);
  }
  cuts.push(count);
  signatures.forEach(([role, hint], index) => {
    const cell = merged(nextRow, cuts[index] + 1, cuts[index + 1], '', { alignment: { horizontal: 'center', vertical: 'top' } });
    cell.value = { richText: [{ text: `${role}\n`, font: { ...font, bold: true } }, { text: `${hint}\n\n\n`, font: { ...font, italic: true } }] };
  });
  // A single tall row keeps all signing areas together when printed across pages.
  sheet.getRow(nextRow).height = 100;
  sheet.views = [{ state: 'frozen', ySplit: headerRow, showGridLines: false }];
  sheet.pageSetup.printTitlesRow = `1:${headerRow}`;
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(count).letter}${nextRow}`;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { renderExcel };
