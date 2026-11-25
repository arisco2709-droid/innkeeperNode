import ExcelJS from 'exceljs';
import { INVENTORY_UNIT_MASTER } from '../config/inventoryUnits.js';
import { validateUnitConfiguration } from '../controllers/rawMaterialController.js';

export const MAX_BULK_ROWS = 2000;

const packageUnitSymbols = new Set(
  (INVENTORY_UNIT_MASTER.find(({ category }) => category === 'Package')?.units || [])
    .map(({ unit }) => unit.toLocaleLowerCase())
);

const isPackageUnit = (unit) => Boolean(unit) && (
  unit.category === 'package'
  || packageUnitSymbols.has(String(unit.symbol || '').toLocaleLowerCase())
);

export const TEMPLATE_COLUMNS = [
  { header: 'Material Name *', field: 'name', width: 28, required: true },
  { header: 'Category *', field: 'category', width: 24, required: true },
  { header: 'Subcategory *', field: 'subcategory', width: 28, required: true },
  { header: 'Description', field: 'description', width: 32 },
  { header: 'Storage Type', field: 'storageType', width: 18 },
  { header: 'Base Unit *', field: 'baseUnit', width: 22, required: true },
  { header: 'Purchase Units *', field: 'purchaseUnits', width: 28, required: true },
  { header: 'Default Purchase Unit *', field: 'defaultPurchaseUnit', width: 26, required: true },
  { header: 'Package Units', field: 'packageUnits', width: 42 },
  { header: 'Storage Location *', field: 'location', width: 24, required: true },
  { header: 'Minimum Stock *', field: 'minimumStock', width: 18, required: true },
  { header: 'Minimum Stock Unit *', field: 'minimumStockUnit', width: 24, required: true },
  { header: 'Reorder Level *', field: 'reorderLevel', width: 18, required: true },
  { header: 'Reorder Level Unit *', field: 'reorderLevelUnit', width: 24, required: true },
  { header: 'Desired Stock Level', field: 'desiredStock', width: 22 },
  { header: 'Desired Stock Unit', field: 'desiredStockUnit', width: 22 },
  { header: 'Preferred Supplier', field: 'vendor', width: 24 },
  { header: 'Active', field: 'active', width: 14 }
];

const FIELD_LABELS = Object.fromEntries(TEMPLATE_COLUMNS.map((column) => [column.field, column.header.replace(/\s*\*$/, '')]));

const normalizeHeaderKey = (header) => String(header || '')
  .replace(/\[[^\]]*\]/g, '')
  .replace(/\*/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase();

const HEADER_TO_FIELD = Object.fromEntries(
  TEMPLATE_COLUMNS.map((column) => [normalizeHeaderKey(column.header), column.field])
);

const REQUIRED_HEADERS = TEMPLATE_COLUMNS
  .filter((column) => column.required)
  .map((column) => normalizeHeaderKey(column.header));

const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (value.text !== undefined && value.text !== null) return value.text;
    if (value.result !== undefined && value.result !== null) return value.result;
    if (value.formula) return '';
  }
  return value;
};

const normalizeCell = (value) => {
  const text = cellText(value);
  if (typeof text === 'number') return text;
  if (text instanceof Date) return text;
  return String(text ?? '').trim();
};

export const normalizeMaterialName = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

const displayName = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const isSampleValue = (value) => /^ex:/i.test(String(value ?? '').trim());

export const isSampleRow = (row) => Object.entries(row || {})
  .filter(([key]) => key !== '__excelRow')
  .some(([, value]) => isSampleValue(value));

export const isRowEmpty = (row) => {
  const fields = Object.entries(row || {}).filter(([key]) => key !== '__excelRow');
  if (!fields.length) return true;
  return fields.every(([, value]) => String(value ?? '').trim() === '');
};

const escapeCsv = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const parseCsv = (text) => {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

const rowsFromMatrix = (matrix) => {
  if (!matrix.length) return { headers: [], rows: [] };
  const headers = (matrix[0] || []).map((header) => String(header || '').trim());
  const mappedHeaders = headers.map((header) => HEADER_TO_FIELD[normalizeHeaderKey(header)] || null);
  const rows = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const line = matrix[index] || [];
    const row = { __excelRow: index + 1 };
    mappedHeaders.forEach((field, column) => {
      if (!field || row[field] !== undefined) return;
      row[field] = normalizeCell(line[column] ?? '');
    });
    rows.push(row);
  }
  return { headers, rows };
};

const isZipWorkbook = (buffer) => buffer?.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
const isLegacyXls = (buffer) => buffer?.length > 4
  && buffer[0] === 0xd0
  && buffer[1] === 0xcf
  && buffer[2] === 0x11
  && buffer[3] === 0xe0;

export const isValidRawMaterialTemplate = (headers = []) => {
  const normalized = headers.map(normalizeHeaderKey);
  return REQUIRED_HEADERS.every((header) => normalized.includes(header));
};

export const parseUploadBuffer = async (buffer, filename = '') => {
  const extension = String(filename).split('.').pop()?.toLowerCase() || '';
  if (extension === 'xls' && isLegacyXls(buffer) && !isZipWorkbook(buffer)) {
    const error = new Error('Legacy .xls files cannot be read. Save the workbook as .xlsx or .csv and upload it again.');
    error.statusCode = 400;
    throw error;
  }
  if (extension === 'csv' || (!isZipWorkbook(buffer) && extension !== 'xlsx' && extension !== 'xls')) {
    const matrix = parseCsv(buffer.toString('utf8'));
    return rowsFromMatrix(matrix);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    const error = new Error('The Excel file could not be read. Download a fresh template and try again.');
    error.statusCode = 400;
    throw error;
  }
  const sheet = workbook.getWorksheet('Raw Materials') || workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };
  const headerRow = sheet.getRow(1);
  const width = Math.max(headerRow.cellCount || 0, TEMPLATE_COLUMNS.length);
  const headers = [];
  for (let column = 1; column <= width; column += 1) {
    const value = normalizeCell(headerRow.getCell(column).value);
    if (!value && column > headerRow.cellCount) break;
    headers.push(String(value || ''));
  }
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  const matrix = [headers];
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const excelRow = sheet.getRow(index);
    const line = headers.map((_, column) => normalizeCell(excelRow.getCell(column + 1).value));
    matrix.push(line);
  }
  return rowsFromMatrix(matrix);
};

const listFormula = (column, length) => `Lists!$${column}$2:$${column}$${Math.max(length + 1, 2)}`;

const addListValidation = (sheet, cells, column, length) => {
  if (length < 1) return;
  sheet.dataValidations.add(cells, {
    type: 'list',
    allowBlank: true,
    formulae: [listFormula(column, length)],
    showErrorMessage: true,
    showInputMessage: true,
    errorStyle: 'stop',
    errorTitle: 'Value not allowed',
    error: 'Select a value from the dropdown. Other values cannot be entered.',
    promptTitle: 'Select from the list',
    prompt: 'Only the values in this dropdown are allowed.'
  });
};

const unitLabel = (unit) => `${unit.name} (${unit.symbol})`;

const subcategoryLabel = (category, subcategory) => `${category.name} > ${subcategory.name}`;

export const buildTemplateWorkbook = async ({
  categories = [],
  subcategories = [],
  units = [],
  locations = [],
  vendors = []
} = {}) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Innkeeper';
  const sheet = workbook.addWorksheet('Raw Materials', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });
  sheet.columns = TEMPLATE_COLUMNS.map((column) => ({
    header: column.header,
    key: column.field,
    width: column.width
  }));
  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB45309' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF92400E' } }
    };
  });

  const activeCategories = categories.filter((category) => category.isActive !== false);
  const categoryById = new Map(categories.map((category) => [String(category._id), category]));
  const activeSubcategories = subcategories.filter((subcategory) => (
    subcategory.isActive !== false && categoryById.get(String(subcategory.categoryId))?.isActive !== false
  ));
  const directUnits = units.filter((unit) => unit.isActive !== false && !isPackageUnit(unit)
    && ['weight', 'volume', 'quantity'].includes(unit.category));
  const activeLocations = locations.filter((location) => location.isActive !== false);
  const activeVendors = vendors.filter((vendor) => vendor.status === 'active');
  const sampleCategory = activeCategories[0];
  const sampleSubcategory = activeSubcategories.find((entry) => (
    String(entry.categoryId) === String(sampleCategory?._id)
  ));
  const sampleBase = directUnits.find((unit) => unit.symbol === 'kg') || directUnits[0];
  const samplePurchase = directUnits.find((unit) => unit.symbol === 'g' && sampleBase?.symbol === 'kg') || sampleBase;
  const sampleLocation = activeLocations[0];
  const sampleVendor = activeVendors[0];
  sheet.addRow({
    name: 'ex: Basmati Rice',
    category: sampleCategory?.name || 'Groceries',
    subcategory: sampleCategory && sampleSubcategory
      ? subcategoryLabel(sampleCategory, sampleSubcategory)
      : 'Groceries > Rice',
    description: 'ex: Long grain rice',
    storageType: 'Dry',
    baseUnit: sampleBase ? unitLabel(sampleBase) : 'Kilogram (kg)',
    purchaseUnits: sampleBase && samplePurchase && sampleBase !== samplePurchase
      ? `${unitLabel(sampleBase)}, ${unitLabel(samplePurchase)}`
      : (sampleBase ? unitLabel(sampleBase) : 'kg, g'),
    defaultPurchaseUnit: sampleBase ? unitLabel(sampleBase) : 'kg',
    packageUnits: 'ex: 25 kg Bag | bag | 25 | kg',
    location: sampleLocation?.locationName || 'Main Store',
    minimumStock: 5,
    minimumStockUnit: sampleBase ? unitLabel(sampleBase) : 'kg',
    reorderLevel: 10,
    reorderLevelUnit: sampleBase ? unitLabel(sampleBase) : 'kg',
    desiredStock: 50,
    desiredStockUnit: sampleBase ? unitLabel(sampleBase) : 'kg',
    vendor: sampleVendor?.name || '',
    active: 'Yes'
  });
  sheet.getRow(2).font = { italic: true, color: { argb: 'FF64748B' } };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: TEMPLATE_COLUMNS.length }
  };

  const lists = workbook.addWorksheet('Lists');
  const writeList = (column, title, values) => {
    lists.getCell(1, column).value = title;
    lists.getCell(1, column).font = { bold: true };
    values.forEach((value, index) => {
      lists.getCell(index + 2, column).value = value;
    });
  };
  writeList(1, 'Categories', activeCategories.map((category) => category.name));
  writeList(2, 'Subcategories', activeSubcategories.flatMap((subcategory) => {
    const category = categoryById.get(String(subcategory.categoryId));
    return category ? [subcategoryLabel(category, subcategory)] : [];
  }));
  writeList(3, 'Units', directUnits.map(unitLabel));
  writeList(4, 'Locations', activeLocations.map((location) => location.locationName));
  writeList(5, 'Suppliers', activeVendors.map((vendor) => vendor.name));
  writeList(6, 'Active', ['Yes', 'No']);
  lists.getCell('A1').note = 'Do not edit this sheet. These values are the only ones allowed in the dropdowns.';

  const lastRow = 500;
  addListValidation(sheet, `B2:B${lastRow}`, 'A', activeCategories.length);
  addListValidation(sheet, `C2:C${lastRow}`, 'B', activeSubcategories.length);
  addListValidation(sheet, `F2:F${lastRow}`, 'C', directUnits.length);
  addListValidation(sheet, `H2:H${lastRow}`, 'C', directUnits.length);
  addListValidation(sheet, `J2:J${lastRow}`, 'D', activeLocations.length);
  addListValidation(sheet, `L2:L${lastRow}`, 'C', directUnits.length);
  addListValidation(sheet, `N2:N${lastRow}`, 'C', directUnits.length);
  addListValidation(sheet, `P2:P${lastRow}`, 'C', directUnits.length);
  addListValidation(sheet, `Q2:Q${lastRow}`, 'E', activeVendors.length);
  addListValidation(sheet, `R2:R${lastRow}`, 'F', 2);

  const instructions = workbook.addWorksheet('Instructions');
  instructions.columns = [{ width: 36 }, { width: 110 }];
  const instructionRows = [
    ['Raw material bulk upload', 'Rows whose values start with "ex:" are examples and are not imported.'],
    ['Material Name *', 'Required. A material with the same name already in this property is treated as a duplicate and is not imported.'],
    ['Category *', 'Required. Choose a category from the dropdown. Typed values that are not in the list are rejected.'],
    ['Subcategory *', 'Required. Choose "Category > Subcategory" from the dropdown. Other text is rejected.'],
    ['Base Unit *', 'Required. Choose a weight, volume, or count unit from the dropdown. Other text is rejected.'],
    ['Purchase Units *', 'Required. Comma-separated direct units of the same type, such as "Kilogram (kg), Gram (g)". The base unit is included automatically.'],
    ['Default Purchase Unit *', 'Required. Choose one unit from the dropdown. Other text is rejected.'],
    ['Package Units', 'Optional. Separate packages with a semicolon. Each package is: Name | Unit | Size | Measurement Unit. Example: 25 kg Bag | bag | 25 | kg'],
    ['Package conversion', 'A package converts to the base unit from its size and measurement unit. A 25 kg bag with base unit g is stored as 25000 g.'],
    ['Storage Location *', 'Required. Must match an active storage location. New locations are not created from the file.'],
    ['Stock levels *', 'Minimum stock and reorder level are required numbers (0 is allowed) with a direct unit. Desired stock is optional and cannot be below the reorder level.'],
    ['Preferred Supplier', 'Optional. Choose an active supplier from the dropdown. Other names are rejected.'],
    ['Active', 'Yes or No. Blank means the material is active.'],
    ['Invalid rows', 'Invalid and duplicate rows are skipped. Valid rows are added to the raw material master.']
  ];
  instructionRows.forEach((entry, index) => {
    const row = instructions.addRow(entry);
    if (index === 0) row.font = { bold: true, size: 14 };
    row.alignment = { wrapText: true, vertical: 'top' };
  });
  return workbook;
};

export const buildTemplateCsv = () => {
  const header = TEMPLATE_COLUMNS.map((column) => escapeCsv(column.header)).join(',');
  const sample = [
    'ex: Basmati Rice', 'Groceries', 'Groceries > Rice', 'ex: Long grain rice', 'Dry',
    'Kilogram (kg)', 'Kilogram (kg), Gram (g)', 'Kilogram (kg)', 'ex: 25 kg Bag | bag | 25 | kg',
    'Main Store', '5', 'Kilogram (kg)', '10', 'Kilogram (kg)', '50', 'Kilogram (kg)', '', 'Yes'
  ].map(escapeCsv).join(',');
  return `\uFEFF${header}\n${sample}\n`;
};

const toNumber = (value) => {
  if (value instanceof Date) return { invalid: true };
  if (value === null || value === undefined || value === '') return { empty: true };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value } : { invalid: true };
  }
  const cleaned = String(value).replace(/^ex:/i, '').trim().replace(/,/g, '');
  if (!cleaned) return { empty: true };
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { invalid: true };
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? { value: numeric } : { invalid: true };
};

const parseActive = (value) => {
  const text = String(value ?? '').trim().toLocaleLowerCase();
  if (!text) return true;
  if (['yes', 'y', 'true', '1', 'active'].includes(text)) return true;
  if (['no', 'n', 'false', '0', 'inactive'].includes(text)) return false;
  return null;
};

const matchUnit = (label, units) => {
  const key = String(label || '').trim().toLocaleLowerCase();
  if (!key) return null;
  return units.find((unit) => (
    String(unit.symbol || '').trim().toLocaleLowerCase() === key
    || String(unit.name || '').trim().toLocaleLowerCase() === key
    || unitLabel(unit).toLocaleLowerCase() === key
  )) || null;
};

const splitList = (value) => String(value ?? '')
  .split(/[,;]/)
  .map((part) => part.trim())
  .filter(Boolean);

const parsePackages = (value) => {
  const text = String(value ?? '').replace(/^ex:/i, '').trim();
  if (!text) return [];
  return text.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const pieces = part.split('|').map((piece) => piece.trim());
    if (pieces.length !== 4 || pieces.some((piece) => !piece)) {
      return { error: `Package "${part}" must use Name | Unit | Size | Measurement Unit.` };
    }
    const size = toNumber(pieces[2]);
    if (size.empty || size.invalid || size.value <= 0) {
      return { error: `Package "${pieces[0]}" needs a positive size.` };
    }
    return {
      packageName: pieces[0],
      unitLabel: pieces[1],
      packageSize: size.value,
      measurementLabel: pieces[3]
    };
  });
};

const findNamed = (list, value, readName) => {
  const key = String(value || '').trim().toLocaleLowerCase();
  if (!key) return null;
  return list.find((item) => String(readName(item) || '').trim().toLocaleLowerCase() === key) || null;
};

const convertStock = (quantity, factor) => (
  Math.round((Number(quantity) * Number(factor) + Number.EPSILON) * 100000000) / 100000000
);

const stockFactor = (label, units, configured) => {
  const unit = matchUnit(label, units);
  if (!unit || isPackageUnit(unit)) return { unit, factor: null, packageUnit: isPackageUnit(unit) };
  const entry = configured.find((item) => String(item.unitId) === String(unit._id) && item.isActive !== false);
  return { unit, factor: entry ? Number(entry.conversionFactorToBase) : null, packageUnit: false };
};

export const prepareRawMaterialRow = async (row, context) => {
  const errors = [];
  const name = displayName(String(row.name ?? '').replace(/^ex:/i, ''));
  const requireText = (field) => {
    const value = String(row[field] ?? '').trim();
    if (!value) errors.push(`${FIELD_LABELS[field]} is mandatory.`);
    return value;
  };

  requireText('name');
  const categoryName = requireText('category');
  const subcategoryRaw = requireText('subcategory');
  const baseUnitLabel = requireText('baseUnit');
  const purchaseUnitsRaw = requireText('purchaseUnits');
  const defaultLabel = requireText('defaultPurchaseUnit');
  const locationName = requireText('location');
  requireText('minimumStockUnit');
  requireText('reorderLevelUnit');

  const minimum = toNumber(row.minimumStock);
  const reorder = toNumber(row.reorderLevel);
  const desired = toNumber(row.desiredStock);
  if (minimum.empty) errors.push('Minimum Stock is mandatory. Enter 0 if none is required.');
  else if (minimum.invalid) errors.push('Minimum Stock must be a number.');
  else if (minimum.value < 0) errors.push('Minimum Stock cannot be negative.');
  if (reorder.empty) errors.push('Reorder Level is mandatory. Enter 0 if none is required.');
  else if (reorder.invalid) errors.push('Reorder Level must be a number.');
  else if (reorder.value < 0) errors.push('Reorder Level cannot be negative.');
  if (desired.invalid) errors.push('Desired Stock Level must be a number.');
  else if (!desired.empty && desired.value < 0) errors.push('Desired Stock Level cannot be negative.');
  if (!desired.empty && desired.value > 0 && !String(row.desiredStockUnit || '').trim()) {
    errors.push('Desired Stock Unit is mandatory when Desired Stock Level is greater than 0.');
  }

  const active = parseActive(row.active);
  if (active === null) errors.push('Active must be Yes or No.');

  const category = categoryName
    ? findNamed(context.categories, categoryName, (item) => item.name)
    : null;
  if (categoryName && !category) errors.push(`Category "${categoryName}" was not found.`);
  else if (category && category.isActive === false) errors.push(`Category "${category.name}" is inactive.`);

  let subcategory = null;
  if (category && subcategoryRaw) {
    let subcategoryName = subcategoryRaw.trim();
    const separator = ' > ';
    const separatorAt = subcategoryName.indexOf(separator);
    if (separatorAt !== -1) {
      const owner = subcategoryName.slice(0, separatorAt).trim();
      subcategoryName = subcategoryName.slice(separatorAt + separator.length).trim();
      if (owner.toLocaleLowerCase() !== category.name.trim().toLocaleLowerCase()) {
        errors.push(`Subcategory "${subcategoryRaw}" does not belong to category "${category.name}".`);
      }
    }
    if (subcategoryName) {
      subcategory = context.subcategories.find((item) => (
        String(item.categoryId?._id || item.categoryId) === String(category._id)
        && String(item.name || '').trim().toLocaleLowerCase() === subcategoryName.toLocaleLowerCase()
      )) || null;
      if (!subcategory) errors.push(`Subcategory "${subcategoryRaw}" was not found under ${category.name}.`);
      else if (subcategory.isActive === false) errors.push(`Subcategory "${subcategory.name}" is inactive.`);
    }
  }

  const baseUnit = baseUnitLabel ? matchUnit(baseUnitLabel, context.units) : null;
  if (baseUnitLabel && !baseUnit) errors.push(`Base Unit "${baseUnitLabel}" was not found.`);
  else if (baseUnit && baseUnit.isActive === false) errors.push(`Base Unit "${baseUnit.name}" is inactive.`);
  else if (baseUnit && (isPackageUnit(baseUnit) || !['weight', 'volume', 'quantity'].includes(baseUnit.category))) {
    errors.push('Base Unit must be a weight, volume, or count unit.');
  }

  const purchaseUnits = [];
  splitList(purchaseUnitsRaw).forEach((label) => {
    const unit = matchUnit(label, context.units);
    if (!unit) {
      errors.push(`Purchase unit "${label}" was not found.`);
      return;
    }
    if (unit.isActive === false) {
      errors.push(`Purchase unit "${unit.name}" is inactive.`);
      return;
    }
    if (isPackageUnit(unit)) {
      errors.push(`Package unit "${unit.name}" must be entered in Package Units with a size and measurement unit.`);
      return;
    }
    if (purchaseUnits.some((entry) => String(entry._id) === String(unit._id))) {
      errors.push(`Purchase unit "${unit.name}" is listed more than once.`);
      return;
    }
    purchaseUnits.push(unit);
  });

  const parsedPackages = parsePackages(row.packageUnits);
  const packages = [];
  const packageNames = new Set();
  parsedPackages.forEach((entry) => {
    if (entry.error) {
      errors.push(entry.error);
      return;
    }
    const unit = matchUnit(entry.unitLabel, context.units);
    const measurement = matchUnit(entry.measurementLabel, context.units);
    if (!unit) errors.push(`Package unit "${entry.unitLabel}" was not found.`);
    else if (unit.isActive === false) errors.push(`Package unit "${unit.name}" is inactive.`);
    else if (!isPackageUnit(unit)) errors.push(`"${unit.name}" is not a package unit. Add it to Purchase Units instead.`);
    if (!measurement) errors.push(`Package measurement unit "${entry.measurementLabel}" was not found.`);
    else if (measurement.isActive === false) errors.push(`Package measurement unit "${measurement.name}" is inactive.`);
    const packageKey = entry.packageName.toLocaleLowerCase();
    if (packageNames.has(packageKey)) errors.push(`Package name "${entry.packageName}" is used more than once.`);
    packageNames.add(packageKey);
    if (unit && measurement && isPackageUnit(unit)) {
      packages.push({ ...entry, unit, measurement });
    }
  });

  const location = locationName
    ? findNamed(context.locations, locationName, (item) => item.locationName)
    : null;
  if (locationName && !location) {
    errors.push(`Storage Location "${locationName}" was not found. Choose an active storage location.`);
  } else if (location && location.isActive === false) {
    errors.push(`Storage Location "${location.locationName}" is inactive.`);
  }

  const vendorName = String(row.vendor || '').trim();
  const vendor = vendorName
    ? findNamed(context.vendors, vendorName, (item) => item.name)
    : null;
  if (vendorName && !vendor) errors.push(`Preferred Supplier "${vendorName}" was not found.`);
  else if (vendor && vendor.status !== 'active') errors.push(`Preferred Supplier "${vendor.name}" is inactive.`);

  const directChoices = baseUnit
    ? [baseUnit, ...purchaseUnits.filter((unit) => String(unit._id) !== String(baseUnit._id))]
    : purchaseUnits;
  const defaultPackage = packages.find((entry) => (
    entry.packageName.toLocaleLowerCase() === defaultLabel.toLocaleLowerCase()
  ));
  const defaultDirect = matchUnit(defaultLabel, directChoices);
  const packagesWithUnit = packages.filter((entry) => (
    entry.unit && String(entry.unit.symbol || '').toLocaleLowerCase() === defaultLabel.toLocaleLowerCase()
  ));
  let selectedPackage = defaultPackage || null;
  if (defaultLabel && !defaultDirect && !selectedPackage) {
    if (packagesWithUnit.length === 1) selectedPackage = packagesWithUnit[0];
    else if (packagesWithUnit.length > 1) {
      errors.push(`Default Purchase Unit "${defaultLabel}" matches more than one package. Use the package name.`);
    } else {
      errors.push(`Default Purchase Unit "${defaultLabel}" must be one of the purchase units or a package name.`);
    }
  }
  if (defaultDirect && selectedPackage) {
    errors.push('Choose one Default Purchase Unit.');
  }

  const duplicate = Boolean(name) && context.existingNames.has(normalizeMaterialName(name));
  if (duplicate) {
    errors.unshift(`Duplicate raw material. "${name}" already exists and was not imported.`);
  }

  if (errors.length || !category || !subcategory || !baseUnit || !location || (vendorName && !vendor)) {
    return {
      ok: false,
      isDuplicate: duplicate,
      errors,
      data: { name }
    };
  }

  const supportedUnits = directChoices.map((unit) => ({
    unitId: String(unit._id),
    isDefaultPurchaseUnit: Boolean(defaultDirect) && String(defaultDirect._id) === String(unit._id),
    isActive: true
  }));
  packages.forEach((entry) => {
    supportedUnits.push({
      unitId: String(entry.unit._id),
      packageName: entry.packageName,
      packageSize: entry.packageSize,
      packageMeasurementUnitId: String(entry.measurement._id),
      isDefaultPurchaseUnit: selectedPackage === entry,
      isActive: true
    });
  });
  if (!supportedUnits.some((entry) => entry.isDefaultPurchaseUnit)) {
    const baseEntry = supportedUnits.find((entry) => String(entry.unitId) === String(baseUnit._id) && !entry.packageName);
    if (baseEntry) baseEntry.isDefaultPurchaseUnit = true;
  }

  const unitResult = await validateUnitConfiguration({
    hotelId: context.hotelId,
    baseUnitId: baseUnit._id,
    supportedUnits
  });
  if (unitResult.error) {
    errors.push(unitResult.error);
    return { ok: false, isDuplicate: duplicate, errors, data: { name } };
  }

  const minimumUnit = stockFactor(row.minimumStockUnit, context.units, unitResult.supportedUnits);
  const reorderUnit = stockFactor(row.reorderLevelUnit, context.units, unitResult.supportedUnits);
  const desiredUnitLabel = String(row.desiredStockUnit || '').trim();
  const desiredUnit = desiredUnitLabel
    ? stockFactor(desiredUnitLabel, context.units, unitResult.supportedUnits)
    : { factor: 1, packageUnit: false, unit: baseUnit };
  if (!minimumUnit.unit) errors.push(`Minimum Stock Unit "${row.minimumStockUnit}" was not found.`);
  else if (minimumUnit.packageUnit || !(minimumUnit.factor > 0)) {
    errors.push('Minimum Stock Unit must be the base unit or a listed direct purchase unit.');
  }
  if (!reorderUnit.unit) errors.push(`Reorder Level Unit "${row.reorderLevelUnit}" was not found.`);
  else if (reorderUnit.packageUnit || !(reorderUnit.factor > 0)) {
    errors.push('Reorder Level Unit must be the base unit or a listed direct purchase unit.');
  }
  if (desiredUnitLabel && (!desiredUnit.unit || desiredUnit.packageUnit || !(desiredUnit.factor > 0))) {
    errors.push('Desired Stock Unit must be the base unit or a listed direct purchase unit.');
  }
  if (errors.length) return { ok: false, isDuplicate: duplicate, errors, data: { name } };

  const minimumStockLevel = convertStock(minimum.value, minimumUnit.factor);
  const reorderLevel = convertStock(reorder.value, reorderUnit.factor);
  const maxStockLevel = desired.empty || desired.value === 0
    ? 0
    : convertStock(desired.value, desiredUnit.factor);
  if (maxStockLevel > 0 && maxStockLevel < reorderLevel) {
    errors.push('Desired stock cannot be below the reorder level after conversion to the base unit.');
    return { ok: false, isDuplicate: duplicate, errors, data: { name } };
  }

  return {
    ok: !duplicate,
    isDuplicate: duplicate,
    errors: duplicate ? errors : [],
    data: { name },
    payload: {
      name,
      categoryId: category._id,
      subcategoryId: subcategory._id,
      description: String(row.description || '').replace(/^ex:/i, '').trim(),
      storageType: String(row.storageType || '').trim(),
      location: location.locationName,
      locationId: location._id,
      isActive: active !== false,
      minimumStockLevel,
      reorderLevel,
      maxStockLevel,
      vendorId: vendor?._id || null,
      baseUnitId: baseUnit._id,
      supportedUnits
    }
  };
};

const resultFill = {
  Success: 'FFE8F5E9',
  Failed: 'FFFDECEC',
  Duplicate: 'FFFFF7ED'
};
const resultFont = {
  Success: 'FF166534',
  Failed: 'FFB91C1C',
  Duplicate: 'FFB45309'
};

export const buildFailedWorkbookBuffer = async (resultRows = []) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Failed Records');
  const columns = [
    { header: 'Row', key: 'rowNumber', width: 10 },
    ...TEMPLATE_COLUMNS.map((column) => ({ header: column.header, key: column.field, width: column.width })),
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Error Reason', key: 'errorReason', width: 72 }
  ];
  sheet.columns = columns;
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB45309' } };
  resultRows.forEach((result) => {
    const row = sheet.addRow({
      rowNumber: result.rowNumber,
      ...(result.values || {}),
      status: result.status,
      errorReason: (result.messages || []).join('\n')
    });
    const statusCell = row.getCell('status');
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: resultFill[result.status] || 'FFF8FAFC' } };
    statusCell.font = { bold: true, color: { argb: resultFont[result.status] || 'FF0F172A' } };
    row.getCell('errorReason').alignment = { wrapText: true, vertical: 'top' };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return workbook.xlsx.writeBuffer();
};

export const uploadStatusFor = ({ successCount, failedCount, duplicateCount }) => {
  if (successCount > 0 && (failedCount > 0 || duplicateCount > 0)) return 'Partially Success';
  if (successCount > 0) return 'Success';
  return 'Failed';
};
