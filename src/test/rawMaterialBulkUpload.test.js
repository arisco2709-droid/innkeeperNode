import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultInventoryUnits } from '../controllers/inventoryUnitController.js';
import {
  getRawMaterialBulkUploadLog,
  getRawMaterialBulkUploadLogs,
  uploadRawMaterialsBulk
} from '../controllers/rawMaterialBulkUploadController.js';
import { createRawMaterialCategory, createRawMaterialSubcategory, getRawMaterials } from '../controllers/rawMaterialController.js';
import { InventoryItem, RawMaterialBulkUploadLog, StorageLocation, StorageLocationType, Vendor } from '../models/index.js';
import { ensureLegacyStorageLocations } from '../services/storageLocationService.js';
import { TEMPLATE_COLUMNS, buildTemplateWorkbook } from '../services/rawMaterialBulkUploadService.js';
import { setup, teardown } from './setup.js';

const hotelId = new mongoose.Types.ObjectId();
const propertyId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();

const requestFor = (overrides = {}) => ({
  hotelId,
  propertyId,
  user: { _id: actorId, role: 'hotel_admin', name: 'Inventory Admin' },
  params: {},
  query: {},
  body: {},
  headers: {},
  socket: {},
  get: () => undefined,
  file: null,
  ...overrides
});

const invoke = async (controller, req) => {
  const res = {
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    send(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    }
  };
  await controller(req, res, (error) => {
    throw error;
  });
  return res;
};

const workbookBuffer = async (rows) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Raw Materials');
  sheet.addRow(TEMPLATE_COLUMNS.map((column) => column.header));
  rows.forEach((row) => {
    sheet.addRow(TEMPLATE_COLUMNS.map((column) => row[column.field] ?? ''));
  });
  return workbook.xlsx.writeBuffer();
};

describe('raw material bulk upload', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('imports valid rows, skips invalid and duplicate rows, and keeps unit conversions', async () => {
    const category = await invoke(createRawMaterialCategory, requestFor({ body: { name: 'Groceries' } }));
    await invoke(createRawMaterialSubcategory, requestFor({
      body: { categoryId: String(category.body.data._id), name: 'Rice' }
    }));
    await invoke(createDefaultInventoryUnits, requestFor());
    await ensureLegacyStorageLocations(hotelId);
    const locationType = await StorageLocationType.findOne({ key: 'main_store' });
    await StorageLocation.create({
      hotelId,
      locationName: 'Main Store',
      normalizedName: 'main store',
      locationTypeId: locationType._id,
      isActive: true
    });
    await Vendor.create({ hotelId, name: 'Fresh Farms', phone: '9876543210', status: 'active' });
    const locationCount = await StorageLocation.countDocuments({ hotelId });

    const template = await buildTemplateWorkbook({
      categories: [category.body.data],
      subcategories: [{ name: 'Rice', categoryId: category.body.data._id, isActive: true }],
      units: [],
      locations: [{ locationName: 'Main Store', isActive: true }],
      vendors: [{ name: 'Fresh Farms', status: 'active' }]
    });
    expect(template.getWorksheet('Raw Materials').getRow(1).getCell(1).value).toBe('Material Name *');
    expect(template.getWorksheet('Instructions')).toBeTruthy();

    const shared = {
      category: 'Groceries',
      subcategory: 'Groceries > Rice',
      description: '',
      storageType: 'Dry',
      location: 'Main Store',
      vendor: '',
      active: 'Yes',
      desiredStock: '',
      desiredStockUnit: ''
    };
    const buffer = await workbookBuffer([
      {
        ...shared,
        name: 'Basmati Rice',
        description: 'Long grain',
        baseUnit: 'g',
        purchaseUnits: 'kg, g',
        defaultPurchaseUnit: '25 kg Bag',
        packageUnits: '25 kg Bag | bag | 25 | kg',
        minimumStock: 5,
        minimumStockUnit: 'kg',
        reorderLevel: 10,
        reorderLevelUnit: 'kg',
        desiredStock: 50,
        desiredStockUnit: 'kg',
        vendor: 'Fresh Farms'
      },
      {
        ...shared,
        name: 'Eggs',
        baseUnit: 'pcs',
        purchaseUnits: 'pcs',
        defaultPurchaseUnit: 'pcs',
        packageUnits: '',
        minimumStock: 0,
        minimumStockUnit: 'pcs',
        reorderLevel: 0,
        reorderLevelUnit: 'pcs'
      },
      { ...shared, name: '', baseUnit: 'kg', purchaseUnits: 'kg', defaultPurchaseUnit: 'kg', minimumStock: 1, minimumStockUnit: 'kg', reorderLevel: 1, reorderLevelUnit: 'kg' },
      { ...shared, name: 'Stone Flour', baseUnit: 'stone', purchaseUnits: 'kg', defaultPurchaseUnit: 'kg', minimumStock: 1, minimumStockUnit: 'kg', reorderLevel: 1, reorderLevelUnit: 'kg' },
      { ...shared, name: 'Negative Salt', baseUnit: 'kg', purchaseUnits: 'kg', defaultPurchaseUnit: 'kg', minimumStock: -5, minimumStockUnit: 'kg', reorderLevel: 1, reorderLevelUnit: 'kg' },
      { ...shared, name: 'Lost Rice', baseUnit: 'kg', purchaseUnits: 'kg', defaultPurchaseUnit: 'kg', location: 'Nowhere', minimumStock: 1, minimumStockUnit: 'kg', reorderLevel: 1, reorderLevelUnit: 'kg' },
      { ...shared, name: 'Ghost Rice', baseUnit: 'kg', purchaseUnits: 'kg', defaultPurchaseUnit: 'kg', vendor: 'Ghost Supplier', minimumStock: 1, minimumStockUnit: 'kg', reorderLevel: 1, reorderLevelUnit: 'kg' },
      {
        ...shared,
        name: 'Basmati Rice',
        baseUnit: 'g',
        purchaseUnits: 'kg, g',
        defaultPurchaseUnit: 'kg',
        minimumStock: 1,
        minimumStockUnit: 'kg',
        reorderLevel: 1,
        reorderLevelUnit: 'kg'
      },
      { ...shared, name: 'Bad Pack', baseUnit: 'kg', purchaseUnits: 'kg', defaultPurchaseUnit: 'kg', packageUnits: 'just text', minimumStock: 1, minimumStockUnit: 'kg', reorderLevel: 1, reorderLevelUnit: 'kg' }
    ]);

    const uploaded = await invoke(uploadRawMaterialsBulk, requestFor({
      file: { buffer: Buffer.from(buffer), originalname: 'raw-materials.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    }));
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.body).toMatchObject({
      success: true,
      totalRecords: 9,
      successCount: 2,
      failedCount: 6,
      duplicateCount: 1,
      uploadStatus: 'Partially Success'
    });
    expect(uploaded.body.rowErrors.map((row) => row.status)).toEqual([
      'Failed', 'Failed', 'Failed', 'Failed', 'Failed', 'Duplicate', 'Failed'
    ]);
    expect(uploaded.body.rowErrors.some((row) => row.messages.join(' ').includes('Material Name is mandatory'))).toBe(true);
    expect(uploaded.body.rowErrors.some((row) => row.messages.join(' ').includes('stone'))).toBe(true);
    expect(uploaded.body.rowErrors.some((row) => row.messages.join(' ').includes('cannot be negative'))).toBe(true);
    expect(uploaded.body.rowErrors.some((row) => row.messages.join(' ').includes('Nowhere'))).toBe(true);
    expect(uploaded.body.rowErrors.some((row) => row.messages.join(' ').includes('Ghost Supplier'))).toBe(true);
    expect(uploaded.body.rowErrors.some((row) => row.messages.join(' ').includes('Duplicate raw material'))).toBe(true);
    expect(uploaded.body.rowErrors.some((row) => row.messages.join(' ').includes('Name | Unit | Size | Measurement Unit'))).toBe(true);
    expect(await StorageLocation.countDocuments({ hotelId })).toBe(locationCount);

    const materials = await invoke(getRawMaterials, requestFor());
    const names = materials.body.data.map((item) => item.name).sort();
    expect(names).toEqual(['Basmati Rice', 'Eggs']);
    const rice = materials.body.data.find((item) => item.name === 'Basmati Rice');
    expect(rice.baseUnit).toBe('g');
    expect(rice.minStockThreshold).toBe(5000);
    expect(rice.reorderLevel).toBe(10000);
    expect(rice.maxStockLevel).toBe(50000);
    expect(rice.location).toBe('Main Store');
    expect(String(rice.vendorId)).toBe(String((await Vendor.findOne({ hotelId, name: 'Fresh Farms' }))._id));
    const bag = rice.supportedUnits.find((entry) => entry.packageName === '25 kg Bag');
    expect(bag).toMatchObject({ packageSize: 25, conversionFactorToBase: 25000 });
    expect(rice.purchaseUnit).toBe('bag');

    const csv = [
      TEMPLATE_COLUMNS.map((column) => column.header).join(','),
      ['CSV Sugar', 'Groceries', 'Rice', '', 'Dry', 'kg', 'kg', 'kg', '', 'Main Store', '1', 'kg', '2', 'kg', '', '', 'Fresh Farms', 'Yes'].join(',')
    ].join('\n');
    const csvUpload = await invoke(uploadRawMaterialsBulk, requestFor({
      file: { buffer: Buffer.from(csv), originalname: 'sugar.csv', mimetype: 'text/csv' }
    }));
    expect(csvUpload.body).toMatchObject({ successCount: 1, failedCount: 0, duplicateCount: 0, uploadStatus: 'Success' });
    const sugar = await InventoryItem.findOne({ hotelId, propertyId, name: 'CSV Sugar' });
    expect(sugar).toMatchObject({ baseUnit: 'kg', minStockThreshold: 1, reorderLevel: 2, inventoryType: 'raw_material' });

    const repeat = await invoke(uploadRawMaterialsBulk, requestFor({
      file: {
        buffer: Buffer.from(await workbookBuffer([{
          ...shared,
          name: 'Basmati Rice',
          baseUnit: 'kg',
          purchaseUnits: 'kg',
          defaultPurchaseUnit: 'kg',
          minimumStock: 1,
          minimumStockUnit: 'kg',
          reorderLevel: 1,
          reorderLevelUnit: 'kg'
        }])),
        originalname: 'repeat.xlsx'
      }
    }));
    expect(repeat.body).toMatchObject({ successCount: 0, duplicateCount: 1, failedCount: 0, uploadStatus: 'Failed' });
    expect(await InventoryItem.countDocuments({ hotelId, propertyId, name: 'Basmati Rice' })).toBe(1);

    const invalid = await invoke(uploadRawMaterialsBulk, requestFor({
      file: { buffer: Buffer.from('Foo,Bar\n1,2\n'), originalname: 'bad.csv' }
    }));
    expect(invalid.statusCode).toBe(400);
    expect(await InventoryItem.countDocuments({ hotelId, propertyId, inventoryType: 'raw_material' })).toBe(3);

    const logs = await invoke(getRawMaterialBulkUploadLogs, requestFor({
      query: { status: 'Partially Success', page: 1, limit: 10 }
    }));
    expect(logs.body.data).toHaveLength(1);
    expect(logs.body.data[0]).toMatchObject({
      fileName: 'raw-materials.xlsx',
      totalRows: 9,
      successCount: 2,
      failedCount: 6,
      duplicateCount: 1,
      uploadStatus: 'Partially Success',
      uploadedByName: 'Inventory Admin',
      hasFailedFile: true
    });

    const detail = await invoke(getRawMaterialBulkUploadLog, requestFor({ params: { id: String(logs.body.data[0]._id) } }));
    expect(detail.body.data.rowResults.filter((row) => row.status !== 'Success')).toHaveLength(7);

    const stored = await RawMaterialBulkUploadLog.findById(logs.body.data[0]._id);
    const failedBook = new ExcelJS.Workbook();
    await failedBook.xlsx.readFile(stored.failedFilePath);
    const reasons = failedBook.getWorksheet('Failed Records').getColumn(21).values.join('\n');
    expect(reasons).toContain('Duplicate raw material');
    expect(reasons).toContain('cannot be negative');
  }, 60000);
});
