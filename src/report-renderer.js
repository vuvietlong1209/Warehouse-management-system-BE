const fs = require('node:fs');
const path = require('node:path');
const { requireDate, httpError } = require('./validation');

const templates = {
  NXT: ['BÁO CÁO TỔNG HỢP NHẬP XUẤT TỒN KHO', 'BC-KHO-01', 13],
  PO: ['BẢNG KÊ PHIẾU NHẬP KHO', 'BC-KHO-03', 8],
  SO: ['BẢNG KÊ PHIẾU XUẤT KHO', 'BC-KHO-04', 8],
  KK: ['BẢNG KÊ PHIẾU KIỂM KÊ', 'BC-KHO-05', 7],
  STOCK: ['BÁO CÁO TỒN KHO', 'BC-KHO-07', 6],
  COGS: ['BÁO CÁO GIÁ VỐN VÀ LỢI NHUẬN', 'BC-KHO-06', 9],
};
const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
const display = (value, referenceDate = '2000-01-01') => typeof value === 'number' ? number.format(value) : value.replace(/^(\d{2}\/\d{2}\/)(\d{2})$/, (_, prefix, year) => `${prefix}${referenceDate.slice(0, 2)}${year}`);
const date = value => { const [year, month, day] = value.split('-'); return `${day}/${month}/${year}`; };
const period = snapshot => snapshot.reportType === 'STOCK' ? `Tính đến ngày ${date(snapshot.toDate)}` : `Từ ngày ${date(snapshot.fromDate)} đến ngày ${date(snapshot.toDate)}`;
const signatures = [
  ['NGƯỜI LẬP BIỂU', '(Ký, ghi rõ họ tên)'],
  ['THỦ KHO', '(Ký, ghi rõ họ tên)'],
  ['KẾ TOÁN TRƯỞNG', '(Ký, ghi rõ họ tên)'],
  ['GIÁM ĐỐC', '(Ký, đóng dấu)'],
];

function validateSnapshot(input) {
  if (!input || typeof input.reportType !== 'string' || !Object.hasOwn(templates, input.reportType)) throw httpError(400, 'Mẫu báo cáo không hợp lệ');
  const [title, formCode, columnCount] = templates[input.reportType];
  const fromDate = requireDate(input.fromDate, 'Từ ngày');
  const toDate = requireDate(input.toDate, 'Đến ngày');
  if (fromDate > toDate) throw httpError(400, 'Từ ngày không được lớn hơn đến ngày');
  if (!['A4', 'A5'].includes(input.paperSize)) throw httpError(400, 'Khổ giấy không hợp lệ');
  if (!Array.isArray(input.columns) || input.columns.length !== columnCount) throw httpError(400, 'Cấu trúc bảng báo cáo không hợp lệ');
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw httpError(400, 'Nội dung báo cáo không hợp lệ hoặc quá dài');
    return value;
  };
  const columns = input.columns.map(column => {
    if (!column || !['left', 'center', 'right'].includes(column.align) || !Number.isFinite(column.width) || column.width < 1 || column.width > 100) throw httpError(400, 'Độ rộng cột báo cáo không hợp lệ');
    return { label: text(column.label, 96), width: column.width, align: column.align };
  });
  const readRows = (rows, maximum) => {
    if (!Array.isArray(rows) || rows.length > maximum) throw httpError(400, `Báo cáo không được vượt quá ${maximum} dòng`);
    return rows.map(row => {
      if (!Array.isArray(row) || row.length !== columnCount) throw httpError(400, 'Số cột của dòng báo cáo không hợp lệ');
      return row.map(value => typeof value === 'number' && Number.isFinite(value) ? value : text(value, 512));
    });
  };
  const createdAt = new Date(input.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw httpError(400, 'Ngày tạo báo cáo không hợp lệ');
  return { reportType: input.reportType, title, formCode, fromDate, toDate, paperSize: input.paperSize,
    warehouseName: text(input.warehouseName, 256), search: text(input.search || '', 128),
    createdAt: createdAt.toISOString(), columns, rows: readRows(input.rows, 10000), totals: readRows(input.totals, 10) };
}

function rowCells(snapshot, row, total = false) {
  let span = 1;
  if (total) while (span < row.length && row[span] === '') span += 1;
  return row.map((value, index) => ({ value: display(value, snapshot.fromDate), index, span: index === 0 ? span : 1,
    align: total && index === 0 ? 'left' : index === 0 ? 'center' : snapshot.columns[index].align }))
    .filter(cell => cell.index === 0 || cell.index >= span);
}

async function renderWord(snapshot) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
    TableLayoutType, AlignmentType, VerticalAlign, BorderStyle, HeadingLevel, Tab, TabStopType } = require('docx');
  const landscape = ['NXT', 'COGS'].includes(snapshot.reportType);
  const page = snapshot.paperSize === 'A5' ? [8391, 11906] : [11906, 16838];
  const margin = snapshot.paperSize === 'A5' ? 397 : 567;
  const tableWidth = (landscape ? page[1] : page[0]) - margin * 2;
  const weights = snapshot.columns.reduce((sum, column) => sum + column.width, 0);
  const widths = snapshot.columns.map(column => Math.floor(tableWidth * column.width / weights));
  widths[widths.length - 1] += tableWidth - widths.reduce((sum, width) => sum + width, 0);
  const fontSize = landscape ? snapshot.paperSize === 'A5' ? 13 : 16 : snapshot.paperSize === 'A5' ? 16 : 18;
  const paragraph = (text, options = {}) => new Paragraph({ children: [new TextRun({ text, font: 'Times New Roman', color: '000000' })], spacing: { after: 100 }, ...options });
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
  const makeRow = (row, header = false, total = false) => new TableRow({ tableHeader: header, cantSplit: true,
    children: rowCells(snapshot, row, total).map(cell => new TableCell({
      columnSpan: cell.span, width: { size: widths.slice(cell.index, cell.index + cell.span).reduce((sum, value) => sum + value, 0), type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER, shading: header || total ? { fill: 'F1F5F9' } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
      margins: { top: 70, bottom: 70, left: 55, right: 55 },
      children: [new Paragraph({ alignment: header ? AlignmentType.CENTER : cell.align,
        spacing: { after: 0, before: 0, line: 240 }, children: [new TextRun({ text: cell.value,
          font: 'Times New Roman', color: '000000', size: fontSize, bold: header || total })] })],
    })) });
  const tableRows = [makeRow(snapshot.columns.map(column => column.label), true),
    ...snapshot.rows.map(row => makeRow(row)), ...snapshot.totals.map(row => makeRow(row, false, true))];
  if (!snapshot.rows.length) tableRows.splice(1, 0, new TableRow({ children: [new TableCell({ columnSpan: snapshot.columns.length,
    children: [paragraph('Không có dữ liệu phù hợp', { alignment: AlignmentType.CENTER })] })] }));
  const noBorder = { style: BorderStyle.NIL };
  const signatureWidths = signatures.map((_, index) => Math.floor(tableWidth / 4) + (index === 3 ? tableWidth % 4 : 0));
  // One unsplittable row keeps all four signing areas together at a page boundary.
  const signatureTable = new Table({ width: { size: tableWidth, type: WidthType.DXA },
    columnWidths: signatureWidths, layout: TableLayoutType.FIXED,
    borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder },
    rows: [new TableRow({ cantSplit: true, children: signatures.map(([role, hint], index) => new TableCell({
      width: { size: signatureWidths[index], type: WidthType.DXA },
      borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
      margins: { top: 0, bottom: 1247, left: 40, right: 40 },
      children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 },
        children: [new TextRun({ text: role, font: 'Times New Roman', size: snapshot.paperSize === 'A5' ? 16 : 18, bold: true })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 },
        children: [new TextRun({ text: hint, font: 'Times New Roman', size: snapshot.paperSize === 'A5' ? 16 : 18, italics: true })] })],
    })) })] });
  const document = new Document({ creator: 'Hệ thống quản lý kho', title: snapshot.title,
    styles: { default: { document: { run: { font: 'Times New Roman', size: 20, color: '000000' } } },
      paragraphStyles: [{ id: 'Title', name: 'Title', basedOn: 'Normal', run: { font: 'Times New Roman', size: 28, bold: true, color: '000000' } }] },
    sections: [{ properties: { page: { size: { width: page[0], height: page[1], orientation: landscape ? 'landscape' : 'portrait' },
      margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children: [
      // A right-aligned tab is anchored to the printable page width, not to spaces
      // after the unit name. Keep this in the document body (first page only).
      new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: tableWidth }], keepNext: true,
        spacing: { after: 100 }, children: [
          new TextRun({ text: 'ĐƠN VỊ: QUẢN LÝ KHO & THEO DÕI TỒN KHO', font: 'Times New Roman',
            size: snapshot.paperSize === 'A5' ? 16 : 20, color: '000000' }),
          new TextRun({ children: [new Tab(), `Mẫu số: ${snapshot.formCode}`], font: 'Times New Roman',
            size: snapshot.paperSize === 'A5' ? 16 : 20, color: '000000' }),
        ] }),
      paragraph(snapshot.title, { heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { before: 160, after: 100 } }),
      paragraph(period(snapshot), { alignment: AlignmentType.CENTER }),
      paragraph(`Kho: ${snapshot.warehouseName}`), ...(snapshot.search ? [paragraph(`Từ khóa: ${snapshot.search}`)] : []),
      paragraph(`Ngày lập: ${new Date(snapshot.createdAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' })}`),
      new Table({ rows: tableRows, width: { size: tableWidth, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED }),
      paragraph('', { spacing: { before: 0, after: 240 }, keepNext: true }),
      signatureTable,
    ] }] });
  return Packer.toBuffer(document);
}

function pdfFontPaths() {
  const windows = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const regular = [path.join(windows, 'times.ttf'), process.env.REPORT_FONT_REGULAR].find(file => file && fs.existsSync(file));
  const bold = [path.join(windows, 'timesbd.ttf'), process.env.REPORT_FONT_BOLD].find(file => file && fs.existsSync(file));
  const italic = [path.join(windows, 'timesi.ttf'), process.env.REPORT_FONT_ITALIC].find(file => file && fs.existsSync(file));
  if (!regular) throw httpError(500, 'Không tìm thấy phông Times New Roman để tạo PDF. Vui lòng cấu hình REPORT_FONT_REGULAR và REPORT_FONT_BOLD.');
  return { regular, bold: bold || regular, italic: italic || regular };
}

async function renderPdf(snapshot) {
  const PDFDocument = require('pdfkit');
  const fonts = pdfFontPaths();
  const margin = snapshot.paperSize === 'A5' ? 20 : 28;
  const landscape = ['NXT', 'COGS'].includes(snapshot.reportType);
  const pdf = new PDFDocument({ size: snapshot.paperSize, layout: landscape ? 'landscape' : 'portrait',
    margin, autoFirstPage: false, info: { Title: snapshot.title, Author: 'Hệ thống quản lý kho' } });
  pdf.registerFont('Regular', fonts.regular).registerFont('Bold', fonts.bold).registerFont('Italic', fonts.italic);
  const chunks = [];
  const finished = new Promise((resolve, reject) => { pdf.on('data', chunk => chunks.push(chunk)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  const fontSize = landscape ? snapshot.paperSize === 'A5' ? 6.5 : 8 : snapshot.paperSize === 'A5' ? 8 : 9;
  let y = margin, pageNumber = 0, widths, positions, bottom;
  const drawRow = (row, header = false, total = false) => {
    const cells = rowCells(snapshot, row, total);
    pdf.font(header || total ? 'Bold' : 'Regular').fontSize(fontSize);
    const measured = cells.map(cell => {
      const width = widths.slice(cell.index, cell.index + cell.span).reduce((sum, value) => sum + value, 0);
      const isNumber = typeof row[cell.index] === 'number';
      // Keep numbers and short column labels intact on narrow A5 tables.
      const noWrap = isNumber || (header && ['STT', 'ĐVT'].includes(cell.value));
      const fittedSize = noWrap ? Math.min(fontSize, fontSize * (width - 7) / Math.max(1, pdf.widthOfString(cell.value))) : fontSize;
      return { ...cell, width, noWrap, fontSize: fittedSize };
    });
    const height = Math.max(20, ...measured.map(cell => pdf.fontSize(cell.fontSize).heightOfString(cell.value, { width: cell.width - 7, lineGap: 1 }) + 9));
    if (!header && y + height > bottom) startPage();
    if (y + height > bottom) throw httpError(400, 'Nội dung một dòng quá dài để in. Vui lòng chọn khổ A4 hoặc rút ngắn dữ liệu danh mục.');
    pdf.font(header || total ? 'Bold' : 'Regular').fontSize(fontSize);
    measured.forEach(cell => {
      const x = positions[cell.index];
      pdf.rect(x, y, cell.width, height).fillAndStroke(header || total ? '#f1f5f9' : '#ffffff', '#d9d9d9');
      pdf.fontSize(cell.fontSize).fillColor('#111827').text(cell.value, x + 3.5, y + 4, { width: cell.width - 7, lineGap: 1,
        lineBreak: !cell.noWrap, align: header ? 'center' : cell.align });
    });
    y += height;
  };
  const startPage = (withTableHeader = true) => {
    pdf.addPage(); pageNumber += 1;
    const width = pdf.page.width - margin * 2;
    bottom = pdf.page.height - margin - 20;
    const weights = snapshot.columns.reduce((sum, column) => sum + column.width, 0);
    widths = snapshot.columns.map(column => width * column.width / weights);
    positions = widths.map((_, index) => margin + widths.slice(0, index).reduce((sum, value) => sum + value, 0));
    y = margin;
    if (pageNumber === 1) {
      pdf.font('Regular').fontSize(8).fillColor('#111827');
      const unit = 'ĐƠN VỊ: QUẢN LÝ KHO & THEO DÕI TỒN KHO';
      const form = `Mẫu số: ${snapshot.formCode}`;
      const formWidth = pdf.widthOfString(form) + 1;
      const unitWidth = width - formWidth - 12;
      const headerHeight = Math.max(pdf.heightOfString(unit, { width: unitWidth }), pdf.heightOfString(form, { width: formWidth }));
      pdf.text(unit, margin, y, { width: unitWidth });
      pdf.text(form, margin + width - formWidth, y, { width: formWidth, align: 'right' });
      y += headerHeight + 10;
      pdf.font('Bold').fontSize(13).text(snapshot.title, margin, y, { width, align: 'center' });
      y = pdf.y + 4;
      pdf.font('Regular').fontSize(9).text(period(snapshot), margin, y, { width, align: 'center' });
      y = pdf.y + 8;
      pdf.text(`Kho: ${snapshot.warehouseName}${snapshot.search ? ` | Từ khóa: ${snapshot.search}` : ''}`, margin, y, { width });
      y = pdf.y + 4;
      pdf.fontSize(8).text(`Ngày lập: ${new Date(snapshot.createdAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' })}`, margin, y, { width });
      y = pdf.y + 10;
    }
    if (withTableHeader) drawRow(snapshot.columns.map(column => column.label), true);
    // Keep the footer inside PDFKit's text boundary to prevent an automatic blank page.
    pdf.font('Regular').fontSize(8).text(`Trang ${pageNumber}`, margin, pdf.page.height - margin - 14, { width, align: 'right', lineBreak: false });
  };
  try {
    startPage();
    if (!snapshot.rows.length) { pdf.font('Regular').fontSize(9).text('Không có dữ liệu phù hợp', margin, y + 10); y += 32; }
    snapshot.rows.forEach(row => drawRow(row));
    snapshot.totals.forEach(row => drawRow(row, false, true));
    const signatureSize = snapshot.paperSize === 'A5' ? 8 : 9;
    const signatureWidth = (pdf.page.width - margin * 2) / signatures.length;
    pdf.fontSize(signatureSize);
    const roleHeight = Math.max(...signatures.map(([role]) => pdf.font('Bold').heightOfString(role, { width: signatureWidth - 8 })));
    const hintHeight = Math.max(...signatures.map(([, hint]) => pdf.font('Italic').heightOfString(hint, { width: signatureWidth - 8 })));
    const signatureHeight = 18 + roleHeight + 4 + hintHeight + 62;
    if (y + signatureHeight > bottom) startPage(false);
    signatures.forEach(([role, hint], index) => {
      const x = margin + signatureWidth * index;
      pdf.font('Bold').fontSize(signatureSize).text(role, x + 4, y + 18, { width: signatureWidth - 8, align: 'center' });
      pdf.font('Italic').fontSize(signatureSize).text(hint, x + 4, y + 18 + roleHeight + 4, { width: signatureWidth - 8, align: 'center' });
    });
    pdf.end();
    return await finished;
  } catch (error) { pdf.destroy(); throw error; }
}

async function renderReportFile(format, input) {
  if (!['EXCEL', 'WORD', 'PDF'].includes(format)) throw httpError(400, 'Định dạng chỉ nhận EXCEL, WORD hoặc PDF');
  const snapshot = validateSnapshot(input);
  const buffer = format === 'EXCEL' ? await require('./report-excel').renderExcel(snapshot, { signatures, period, display }) : format === 'WORD' ? await renderWord(snapshot) : await renderPdf(snapshot);
  const formats = { EXCEL: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'], WORD: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'], PDF: ['application/pdf', 'pdf'] };
  return { buffer, mime: formats[format][0], filename: `Bao_cao_${snapshot.reportType}_${snapshot.fromDate}_${snapshot.toDate}.${formats[format][1]}` };
}

module.exports = { validateSnapshot, renderReportFile };
