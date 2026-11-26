import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInventoryItem,
  createPurchaseOrder,
  createVendor,
  getInventoryBatches,
  recordStockMovement,
  createStockReceiptRequest,
  cancelPurchaseMovement,
  correctPurchaseMovement,
  receivePurchaseOrderGoods,
  updateVendor
} from '../controllers/inventoryController.js';
import {
  createRawMaterial,
  createRawMaterialCategory,
  createRawMaterialSubcategory,
  deleteRawMaterial,
  getRawMaterials,
  updateRawMaterial,
  getRawMaterialSubcategories
} from '../controllers/rawMaterialController.js';
import { createDefaultInventoryUnits, createInventoryUnit } from '../controllers/inventoryUnitController.js';
import { cancelStockTransfer } from '../controllers/inventoryAdvancedController.js';
import { GoodsReceipt, InventoryBalance, InventoryBatch, InventoryItem, PurchaseOrder, StockMovement, Unit, Vendor } from '../models/index.js';
import { postStockMovement, runInventoryTransaction, transferStock } from '../services/inventoryService.js';
import { setup, teardown } from './setup.js';

const hotelId = new mongoose.Types.ObjectId();
const otherHotelId = new mongoose.Types.ObjectId();
const propertyId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();

const requestFor = (overrides = {}) => ({
  hotelId,
  propertyId,
  user: { _id: actorId, role: 'hotel_admin' },
  params: {},
  query: {},
  body: {},
  headers: {},
  socket: {},
  get: () => undefined,
  ...overrides
});

const invoke = async (controller, req) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  await controller(req, res, (error) => {
    throw error;
  });
  return res;
};

describe('raw material master API', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('creates hotel-scoped categories and filters subcategories by category', async () => {
    const category = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Bulb Root Vegetables', description: 'Fresh vegetables' }
    }));
    expect(category.statusCode).toBe(201);
    expect(category.body.data.categoryCode).toMatch(/^BRV\d{3}$/);

    const otherCategory = await invoke(createRawMaterialCategory, requestFor({
      hotelId: otherHotelId,
      body: { name: 'Groceries' }
    }));
    await invoke(createRawMaterialSubcategory, requestFor({
      hotelId: otherHotelId,
      body: { categoryId: String(otherCategory.body.data._id), name: 'Other Subcategory' }
    }));
    const subcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: { categoryId: String(category.body.data._id), name: 'Bulb Vegetables' }
    }));
    expect(subcategory.statusCode).toBe(201);

    const filtered = await invoke(getRawMaterialSubcategories, requestFor({
      query: { categoryId: String(category.body.data._id) }
    }));
    expect(filtered.body.data.map((entry) => entry.name)).toEqual(['Bulb Vegetables']);
    expect(filtered.body.data.some((entry) => String(entry.hotelId) === String(otherCategory.body.data.hotelId))).toBe(false);
  });

  it('validates material-specific package conversions and snapshots purchase conversion history', async () => {
    const category = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Raw Vegetables' }
    }));
    const subcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: { categoryId: String(category.body.data._id), name: 'Root Vegetables' }
    }));
    await invoke(createDefaultInventoryUnits, requestFor());
    const units = await Unit.find({ hotelId });
    const unitBySymbol = new Map(units.map((unit) => [unit.symbol, unit]));
    const gram = unitBySymbol.get('g');
    const kilogram = unitBySymbol.get('kg');
    const bag = unitBySymbol.get('bag');
    const millilitre = unitBySymbol.get('ml');
    const piece = unitBySymbol.get('pcs');
    const tray = unitBySymbol.get('tray');
    const carton = unitBySymbol.get('carton');
    expect(gram && kilogram && bag && millilitre && piece && tray && carton).toBeTruthy();

    const customUnit = await invoke(createInventoryUnit, requestFor({
      body: {
        name: 'Scoop',
        symbol: 'scoop',
        category: 'quantity',
        baseUnitId: String(piece._id),
        conversionFactor: 2
      }
    }));
    expect(customUnit.statusCode).toBe(201);
    const invalidCustomUnit = await invoke(createInventoryUnit, requestFor({
      body: {
        name: 'Invalid Scoop',
        symbol: 'invalid-scoop',
        category: 'quantity',
        baseUnitId: String(piece._id),
        conversionFactor: -1
      }
    }));
    expect(invalidCustomUnit.statusCode).toBe(400);

    const countCategory = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Test Count Items' }
    }));
    const countSubcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: { categoryId: String(countCategory.body.data._id), name: 'Count Units' }
    }));
    const customMaterial = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Eggs',
        categoryId: String(countCategory.body.data._id),
        subcategoryId: String(countSubcategory.body.data._id),
        baseUnitId: String(piece._id),
        supportedUnits: [
          {
            unitId: String(carton._id),
            packageSize: 12,
            packageMeasurementUnitId: String(tray._id)
          },
          {
            unitId: String(tray._id),
            packageSize: 30,
            packageMeasurementUnitId: String(piece._id)
          },
          {
            unitId: String(customUnit.body.data._id),
            conversionFactorToBase: 7,
            isDefaultPurchaseUnit: true
          }
        ]
      }
    }));
    expect(customMaterial.statusCode).toBe(201);
    expect(customMaterial.body.data.supportedUnits.find((entry) => (
      String(entry.unitId) === String(customUnit.body.data._id)
    )).conversionFactorToBase).toBe(2);
    expect(customMaterial.body.data.supportedUnits.find((entry) => (
      String(entry.unitId) === String(carton._id)
    )).conversionFactorToBase).toBe(360);

    const created = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Onion',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        minimumStockLevel: 250,
        reorderLevel: 500,
        maxStockLevel: 20000,
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id) },
          {
            unitId: String(bag._id),
            packageName: 'Big Bag',
            packageSize: 25,
            packageMeasurementUnitId: String(kilogram._id),
            isDefaultPurchaseUnit: true
          },
          {
            unitId: String(bag._id),
            packageName: 'Small Bag',
            packageSize: 5,
            packageMeasurementUnitId: String(kilogram._id)
          }
        ]
      }
    }));
    expect(created.statusCode).toBe(201);
    expect(created.body.data.code).toMatch(/^RV\d{3}-0001$/);
    expect(created.body.data).toMatchObject({ minStockThreshold: 250, reorderLevel: 500, maxStockLevel: 20000 });
    expect(created.body.data.supportedUnits.find((entry) => String(entry.unitId) === String(bag._id)))
      .toMatchObject({ packageSize: 25, conversionFactorToBase: 25000 });
    expect(created.body.data.supportedUnits.filter((entry) => String(entry.unitId) === String(bag._id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ packageName: 'Big Bag', conversionFactorToBase: 25000 }),
        expect.objectContaining({ packageName: 'Small Bag', conversionFactorToBase: 5000 })
      ]));
    const automaticOrder = await PurchaseOrder.findOne({
      autoReorderItemId: created.body.data._id
    });
    expect(automaticOrder).toMatchObject({
      autoGenerated: true,
      status: 'draft'
    });
    expect(automaticOrder.items[0]).toMatchObject({
      quantity: 1,
      packageNameSnapshot: 'Big Bag',
      conversionFactor: 25000
    });
    const duplicatePackageName = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Duplicate Package Name',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [
          { unitId: String(bag._id), packageName: 'Bag', packageSize: 5, packageMeasurementUnitId: String(kilogram._id) },
          { unitId: String(bag._id), packageName: 'Bag', packageSize: 25, packageMeasurementUnitId: String(kilogram._id), isDefaultPurchaseUnit: true }
        ]
      }
    }));
    expect(duplicatePackageName.statusCode).toBe(400);
    const listed = await invoke(getRawMaterials, requestFor());
    expect(listed.body.data.map((entry) => entry.name)).toContain('Onion');
    const otherProperty = await invoke(getRawMaterials, requestFor({
      propertyId: new mongoose.Types.ObjectId()
    }));
    expect(otherProperty.body.data).toHaveLength(0);
    const missingScope = await invoke(getRawMaterials, requestFor({ propertyId: null }));
    expect(missingScope.statusCode).toBe(400);

    const invalid = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Invalid Onion',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [{
          unitId: String(bag._id),
          packageSize: 1,
          packageMeasurementUnitId: String(millilitre._id)
        }]
      }
    }));
    expect(invalid.statusCode).toBe(400);
    const bypassMaster = await invoke(createInventoryItem, requestFor({
      body: { name: 'Unconfigured', code: 'UNCONFIGURED', inventoryType: 'raw_material' }
    }));
    expect(bypassMaster.statusCode).toBe(400);

    const vendor = await Vendor.create({
      hotelId,
      name: 'Vegetable Supplier',
      phone: '1234567890'
    });
    const purchase = await invoke(createPurchaseOrder, requestFor({
      body: {
        vendorId: String(vendor._id),
        items: [{
          itemId: String(created.body.data._id),
          unitId: String(bag._id),
          unit: 'bag',
          quantity: 2,
          unitCost: 500
        }],
        taxAmount: 100
      }
    }));
    expect(purchase.statusCode).toBe(201);
    const purchaseOrder = await PurchaseOrder.findById(purchase.body.data._id);
    expect(purchaseOrder.items[0]).toMatchObject({
      unit: 'bag',
      unitNameSnapshot: 'Big Bag',
      packageNameSnapshot: 'Big Bag',
      baseUnit: 'g',
      baseUnitNameSnapshot: 'Gram',
      conversionFactor: 25000
    });
    const smallBagConfig = created.body.data.supportedUnits.find((entry) => entry.packageName === 'Small Bag');
    const smallBagPurchase = await invoke(createPurchaseOrder, requestFor({
      body: {
        vendorId: String(vendor._id),
        items: [{
          itemId: String(created.body.data._id),
          unitId: String(bag._id),
          purchasePackageId: String(smallBagConfig._id),
          unit: 'bag',
          quantity: 3,
          unitCost: 100
        }]
      }
    }));
    expect(smallBagPurchase.statusCode).toBe(201);
    expect(smallBagPurchase.body.data.items[0]).toMatchObject({
      purchasePackageId: smallBagConfig._id,
      packageNameSnapshot: 'Small Bag',
      conversionFactor: 5000
    });

    const baseUnitChange = await invoke(updateRawMaterial, requestFor({
      params: { id: String(created.body.data._id) },
      body: {
        baseUnitId: String(kilogram._id),
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id) },
          {
            _id: created.body.data.supportedUnits.find((entry) => entry.packageName === 'Big Bag')._id,
            unitId: String(bag._id),
            packageName: 'Big Bag',
            packageSize: 25,
            packageMeasurementUnitId: String(kilogram._id)
          }
        ]
      }
    }));
    expect(baseUnitChange.statusCode).toBe(409);

    const updated = await invoke(updateRawMaterial, requestFor({
      params: { id: String(created.body.data._id) },
      body: {
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id) },
          {
            _id: created.body.data.supportedUnits.find((entry) => entry.packageName === 'Big Bag')._id,
            unitId: String(bag._id),
            packageName: 'Big Bag',
            packageSize: 30,
            packageMeasurementUnitId: String(kilogram._id),
            isDefaultPurchaseUnit: true
          },
          {
            _id: created.body.data.supportedUnits.find((entry) => entry.packageName === 'Small Bag')._id,
            unitId: String(bag._id),
            packageName: 'Small Bag',
            packageSize: 5,
            packageMeasurementUnitId: String(kilogram._id)
          }
        ]
      }
    }));
    expect(updated.statusCode).toBe(200);
    expect(updated.body.data.supportedUnits.find((entry) => String(entry.unitId) === String(bag._id)).conversionFactorToBase)
      .toBe(30000);
    expect((await PurchaseOrder.findById(purchaseOrder._id)).items[0].conversionFactor).toBe(25000);

    const received = await invoke(receivePurchaseOrderGoods, requestFor({
      params: { id: String(purchaseOrder._id) },
      body: {
        items: [{
          itemId: String(created.body.data._id),
          receivedQuantity: 2,
          acceptedQuantity: 2
        }]
      }
    }));
    expect(received.statusCode).toBe(200);
    const receipt = await GoodsReceipt.findOne({ purchaseOrderId: purchaseOrder._id });
    expect(receipt.lines[0]).toMatchObject({
      unitNameSnapshot: 'Big Bag',
      packageNameSnapshot: 'Big Bag',
      baseUnitNameSnapshot: 'Gram',
      conversionFactor: 25000,
      purchaseTaxAmount: 100,
      taxInclusiveUnitCost: 550
    });
    expect(receipt.purchaseTaxAmount).toBe(100);
    const stockMovement = await StockMovement.findOne({ itemId: created.body.data._id, movementType: 'receipt' });
    expect(stockMovement.conversionFactor).toBe(25000);
    const taxInclusiveBatch = await InventoryBatch.findOne({ purchaseOrderId: purchaseOrder._id });
    expect(taxInclusiveBatch.unitCost).toBeCloseTo(550 / 25000, 8);
    expect(taxInclusiveBatch.purchaseTaxAmount).toBe(100);
    expect((await InventoryItem.findById(created.body.data._id)).currentStock).toBe(50000);
    const reconfigured = await invoke(updateRawMaterial, requestFor({
      params: { id: String(created.body.data._id) },
      body: {
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id) },
          {
            _id: updated.body.data.supportedUnits.find((entry) => entry.packageName === 'Big Bag')._id,
            unitId: String(bag._id),
            packageName: 'Big Bag',
            packageSize: 35,
            packageMeasurementUnitId: String(kilogram._id),
            isDefaultPurchaseUnit: true
          },
          {
            _id: updated.body.data.supportedUnits.find((entry) => entry.packageName === 'Small Bag')._id,
            unitId: String(bag._id),
            packageName: 'Small Bag',
            packageSize: 5,
            packageMeasurementUnitId: String(kilogram._id)
          }
        ]
      }
    }));
    expect(reconfigured.statusCode).toBe(200);
    expect((await InventoryItem.findById(created.body.data._id)).currentStock).toBe(50000);
    const smallBag = updated.body.data.supportedUnits.find((entry) => entry.packageName === 'Small Bag');
    const stockAdded = await invoke(recordStockMovement, requestFor({
      body: {
        itemId: String(created.body.data._id),
        movementType: 'receipt',
        purchasePackageId: String(smallBag._id),
        packageQuantity: 4,
        looseQuantity: 500,
        purchaseUnitPrice: 100
      }
    }));
    expect(stockAdded.statusCode).toBe(201);
    const packageMovement = await StockMovement.findOne({
      itemId: created.body.data._id,
      purchasePackageId: smallBag._id
    });
    expect(String(packageMovement.purchasePackageId)).toBe(String(smallBag._id));
    expect(packageMovement).toMatchObject({
      quantity: 20500,
      enteredQuantity: 4,
      enteredUnit: 'Small Bag',
      purchasePackageName: 'Small Bag',
      looseQuantity: 500,
      conversionFactor: 5000
    });
    expect((await InventoryItem.findById(created.body.data._id)).currentStock).toBe(70500);
    const taxInclusiveReceipt = await invoke(recordStockMovement, requestFor({
      body: {
        itemId: String(created.body.data._id),
        movementType: 'receipt',
        quantity: 5000,
        unit: 'g',
        purchaseUnitPrice: 0.02,
        purchaseTaxAmount: 10
      }
    }));
    expect(taxInclusiveReceipt.statusCode).toBe(201);
    const directReceiptBatch = await InventoryBatch.findOne({
      itemId: created.body.data._id,
      purchaseTaxAmount: 10
    });
    expect(directReceiptBatch.unitCost).toBeCloseTo(0.022, 8);
    expect(directReceiptBatch.purchaseTaxAmount).toBe(10);
    expect((await InventoryItem.findById(created.body.data._id)).currentStock).toBe(75500);
    expect(await InventoryItem.countDocuments({ hotelId, propertyId, inventoryType: 'raw_material' })).toBe(2);
  });

  it('blocks unconfigured or incomplete raw-material receipts and records a converted purchase', async () => {
    await invoke(createDefaultInventoryUnits, requestFor());
    const units = await Unit.find({ hotelId, isActive: true });
    const gram = units.find((unit) => unit.symbol === 'g');
    const kilogram = units.find((unit) => unit.symbol === 'kg');
    const category = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Purchase Validation Materials' }
    }));
    const subcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: {
        categoryId: String(category.body.data._id),
        name: 'Purchase Validation Subcategory'
      }
    }));
    const vendor = await Vendor.create({
      hotelId,
      name: 'Purchase Validation Supplier',
      phone: '5550101'
    });
    const unconfigured = await InventoryItem.create({
      hotelId,
      propertyId,
      name: 'Unconfigured rice',
      code: `UR-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: '',
      baseUnitId: null,
      currentStock: 0
    });
    const rejectedOrder = await invoke(createPurchaseOrder, requestFor({
      body: {
        vendorId: String(vendor._id),
        items: [{ itemId: String(unconfigured._id), unit: 'kg', quantity: 5, unitCost: 100 }]
      }
    }));
    expect(rejectedOrder.statusCode).toBe(400);
    expect(rejectedOrder.body.message).toBe(
      'Base unit is not configured for this raw material. Please configure the base unit before adding stock.'
    );

    const rejectedReceipt = await invoke(createStockReceiptRequest, requestFor({
      body: {
        itemId: String(unconfigured._id),
        quantity: 5,
        unit: 'kg',
        purchaseUnitPrice: 100
      }
    }));
    expect(rejectedReceipt.statusCode).toBe(400);
    expect(rejectedReceipt.body.message).toBe(rejectedOrder.body.message);
    await InventoryBatch.create({
      hotelId,
      propertyId,
      itemId: unconfigured._id,
      location: 'Main Store',
      quantity: 5,
      remainingQuantity: 5,
      unitCost: 1
    });
    const legacyBatches = await invoke(getInventoryBatches, requestFor({
      query: { itemId: String(unconfigured._id) }
    }));
    expect(legacyBatches.body.data[0]).toMatchObject({
      dataIntegrityStatus: 'configuration_required',
      dataIntegrityMessage: rejectedOrder.body.message
    });

    const validMaterial = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Basmathi rice',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id), isDefaultPurchaseUnit: true }
        ]
      }
    }));
    expect(validMaterial.statusCode).toBe(201);
    const material = await InventoryItem.findById(validMaterial.body.data._id);
    const kgConfiguration = material.supportedUnits.find((entry) => (
      String(entry.unitId) === String(kilogram._id)
    ));
    kgConfiguration.conversionFactorToBase = 999;
    await material.save();
    const rejectedConversion = await invoke(createStockReceiptRequest, requestFor({
      body: {
        itemId: String(material._id),
        quantity: 5,
        unit: 'kg',
        purchaseUnitPrice: 100
      }
    }));
    expect(rejectedConversion.statusCode).toBe(400);
    expect(rejectedConversion.body.message).toContain('Unit conversion configuration is invalid');

    kgConfiguration.conversionFactorToBase = 1000;
    await material.save();
    const zeroQuantity = await invoke(createStockReceiptRequest, requestFor({
      body: {
        itemId: String(material._id),
        quantity: 0,
        unit: 'kg',
        purchaseUnitPrice: 100
      }
    }));
    expect(zeroQuantity.statusCode).toBe(400);

    await expect(runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId,
      itemId: material._id,
      movementType: 'receipt',
      quantity: 5,
      unit: 'kg',
      conversionFactor: 1000,
      session
    }))).rejects.toMatchObject({ statusCode: 400, message: 'Purchase price is required before adding raw material stock.' });

    const purchase = await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId,
      itemId: material._id,
      movementType: 'receipt',
      quantity: 5,
      unit: 'kg',
      conversionFactor: 1000,
      purchaseUnitPrice: 100,
      session
    }));
    const batch = await InventoryBatch.findOne({ itemId: material._id });
    expect(purchase.movement.quantity).toBe(5000);
    expect(batch).toMatchObject({
      quantity: 5000,
      remainingQuantity: 5000,
      purchaseQuantity: 5,
      purchaseUnit: 'kg',
      purchaseUnitCost: 100,
      purchaseAmount: 500,
      purchaseConversionFactor: 1000
    });
    const validBatches = await invoke(getInventoryBatches, requestFor({
      query: { itemId: String(material._id) }
    }));
    expect(validBatches.body.data[0].dataIntegrityStatus).toBe('valid');
  });

  it('deactivates unused raw materials and blocks delete when stock or history exists', async () => {
    await invoke(createDefaultInventoryUnits, requestFor());
    const units = await Unit.find({ hotelId, isActive: true });
    const gram = units.find((unit) => unit.symbol === 'g');
    const kilogram = units.find((unit) => unit.symbol === 'kg');
    const category = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Delete Validation Materials' }
    }));
    const subcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: {
        categoryId: String(category.body.data._id),
        name: 'Delete Validation Subcategory'
      }
    }));
    const unused = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Unused delete material',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id), isDefaultPurchaseUnit: true }
        ]
      }
    }));
    expect(unused.statusCode).toBe(201);
    const deleted = await invoke(deleteRawMaterial, requestFor({
      params: { id: String(unused.body.data._id) }
    }));
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body.data.isActive).toBe(false);

    const stocked = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Stocked delete material',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id), isDefaultPurchaseUnit: true }
        ]
      }
    }));
    await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId,
      itemId: stocked.body.data._id,
      movementType: 'receipt',
      quantity: 1,
      unit: 'kg',
      conversionFactor: 1000,
      purchaseUnitPrice: 50,
      recordedBy: actorId,
      session
    }));
    const blocked = await invoke(deleteRawMaterial, requestFor({
      params: { id: String(stocked.body.data._id) }
    }));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.message).toMatch(/stock|history/i);
    expect((await InventoryItem.findById(stocked.body.data._id)).isActive).toBe(true);
  });

  it('rejects duplicate vendor names case-insensitively per hotel', async () => {
    const created = await invoke(createVendor, requestFor({
      body: { name: 'Fresh Farms', phone: '9000000001' }
    }));
    expect(created.statusCode).toBe(201);
    const duplicate = await invoke(createVendor, requestFor({
      body: { name: 'fresh farms', phone: '9000000002' }
    }));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.message).toMatch(/name/i);

    const other = await invoke(createVendor, requestFor({
      body: { name: 'Other Farms', phone: '9000000003' }
    }));
    const renamed = await invoke(updateVendor, requestFor({
      params: { id: String(other.body.data._id) },
      body: { name: 'FRESH FARMS' }
    }));
    expect(renamed.statusCode).toBe(409);
  });

  it('updates an unused receipt in place without creating a new batch', async () => {
    await invoke(createDefaultInventoryUnits, requestFor());
    const units = await Unit.find({ hotelId, isActive: true });
    const gram = units.find((unit) => unit.symbol === 'g');
    const kilogram = units.find((unit) => unit.symbol === 'kg');
    const category = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'In Place Edit Materials' }
    }));
    const subcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: {
        categoryId: String(category.body.data._id),
        name: 'In Place Edit Subcategory'
      }
    }));
    const material = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'In place aavul',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id), isDefaultPurchaseUnit: true }
        ]
      }
    }));
    const receipt = await invoke(recordStockMovement, requestFor({
      body: {
        itemId: String(material.body.data._id),
        movementType: 'receipt',
        quantity: 5,
        unit: 'kg',
        purchaseUnitPrice: 80,
        batchNumber: 'INPLACE_AAVUL_B1'
      }
    }));
    expect(receipt.statusCode).toBe(201);
    const originalMovementId = String(receipt.body.data.movement._id);
    const batchesBefore = await InventoryBatch.find({ itemId: material.body.data._id });
    expect(batchesBefore).toHaveLength(1);
    const originalBatchId = String(batchesBefore[0]._id);
    expect(batchesBefore[0].quantity).toBe(5000);
    expect(batchesBefore[0].purchaseUnitCost).toBe(80);

    const updated = await invoke(correctPurchaseMovement, requestFor({
      params: { id: originalMovementId },
      body: {
        inPlace: true,
        quantity: 7,
        unit: 'kg',
        purchaseUnitPrice: 90,
        notes: 'Corrected qty and price'
      }
    }));
    expect(updated.body.success).toBe(true);
    expect(updated.body.message).toMatch(/updated/i);
    expect(String(updated.body.data.movement._id)).toBe(originalMovementId);
    expect(String(updated.body.data.batch._id)).toBe(originalBatchId);
    expect(updated.body.data.movement.quantity).toBe(7000);
    expect(updated.body.data.movement.purchaseUnitPrice).toBe(90);
    expect(updated.body.data.movement.metadata.correctedInPlace).toBe(true);
    expect(updated.body.data.batch.quantity).toBe(7000);
    expect(updated.body.data.batch.remainingQuantity).toBe(7000);
    expect(updated.body.data.batch.purchaseUnitCost).toBe(90);
    expect((await InventoryItem.findById(material.body.data._id)).currentStock).toBe(7000);
    expect(await InventoryBatch.countDocuments({ itemId: material.body.data._id })).toBe(1);
    expect(await StockMovement.countDocuments({
      itemId: material.body.data._id,
      movementType: 'receipt'
    })).toBe(1);

    const batchesResponse = await invoke(getInventoryBatches, requestFor({
      query: { itemId: String(material.body.data._id) }
    }));
    const listed = batchesResponse.body.data.find((batch) => String(batch._id) === originalBatchId);
    expect(listed.receiptMovementId).toBe(originalMovementId);
  });

  it('applies tax and discount on receipt movements and supports cancel/correct', async () => {
    await invoke(createDefaultInventoryUnits, requestFor());
    const units = await Unit.find({ hotelId, isActive: true });
    const gram = units.find((unit) => unit.symbol === 'g');
    const kilogram = units.find((unit) => unit.symbol === 'kg');
    const category = await invoke(createRawMaterialCategory, requestFor({
      body: { name: 'Purchase Finance Materials' }
    }));
    const subcategory = await invoke(createRawMaterialSubcategory, requestFor({
      body: {
        categoryId: String(category.body.data._id),
        name: 'Purchase Finance Subcategory'
      }
    }));
    const material = await invoke(createRawMaterial, requestFor({
      body: {
        name: 'Tax discount rice',
        categoryId: String(category.body.data._id),
        subcategoryId: String(subcategory.body.data._id),
        baseUnitId: String(gram._id),
        supportedUnits: [
          { unitId: String(gram._id) },
          { unitId: String(kilogram._id), isDefaultPurchaseUnit: true }
        ]
      }
    }));
    const receipt = await invoke(recordStockMovement, requestFor({
      body: {
        itemId: String(material.body.data._id),
        movementType: 'receipt',
        quantity: 10,
        unit: 'kg',
        purchaseUnitPrice: 100,
        discountAmount: 50,
        taxPercent: 10
      }
    }));
    expect(receipt.statusCode).toBe(201);
    expect(receipt.body.data.movement.metadata.purchaseFinancials).toMatchObject({
      subtotal: 1000,
      discountAmount: 50,
      taxAmount: 95,
      grandTotal: 1045
    });
    expect(receipt.body.data.movement.totalValue).toBe(1045);
    expect((await InventoryItem.findById(material.body.data._id)).currentStock).toBe(10000);

    const corrected = await invoke(correctPurchaseMovement, requestFor({
      params: { id: String(receipt.body.data.movement._id) },
      body: {
        quantity: 8,
        unit: 'kg',
        purchaseUnitPrice: 100,
        discountAmount: 0,
        taxAmount: 40,
        notes: 'Corrected quantity'
      }
    }));
    expect(corrected.body.success).toBe(true);
    expect(corrected.body.data.movement.metadata.purchaseFinancials).toMatchObject({
      subtotal: 800,
      discountAmount: 0,
      taxAmount: 40,
      grandTotal: 840
    });
    expect((await InventoryItem.findById(material.body.data._id)).currentStock).toBe(8000);

    const cancelled = await invoke(cancelPurchaseMovement, requestFor({
      params: { id: String(corrected.body.data.movement._id) },
      body: { notes: 'Cancel corrected purchase' }
    }));
    expect(cancelled.body.success).toBe(true);
    expect((await InventoryItem.findById(material.body.data._id)).currentStock).toBe(0);
    const again = await invoke(cancelPurchaseMovement, requestFor({
      params: { id: String(corrected.body.data.movement._id) }
    }));
    expect(again.body.data.duplicate).toBe(true);
  });

  it('cancels a transfer and reverses both locations once', async () => {
    const isolatedHotelId = new mongoose.Types.ObjectId();
    const isolatedPropertyId = new mongoose.Types.ObjectId();
    const item = await InventoryItem.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      name: `Transfer cancel item ${new mongoose.Types.ObjectId()}`,
      code: new mongoose.Types.ObjectId().toString().slice(-8),
      unit: 'kg',
      baseUnit: 'kg',
      purchaseUnit: 'kg',
      currentStock: 20,
      minStockThreshold: 0,
      unitCost: 10,
      isActive: true
    });
    await InventoryBalance.create({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      location: 'Main Store',
      quantity: 20
    });
    const transfer = await runInventoryTransaction((session) => transferStock({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      itemId: item._id,
      quantity: 5,
      unit: 'kg',
      fromLocation: 'Main Store',
      toLocation: 'Kitchen Store',
      recordedBy: actorId,
      referenceNumber: 'TRF-CANCEL-TEST',
      idempotencyKey: 'trf-cancel-test',
      session
    }));
    expect(transfer.duplicate).toBe(false);
    expect(await InventoryBalance.findOne({ itemId: item._id, location: 'Main Store' })
      .then((balance) => balance.quantity)).toBe(15);
    expect(await InventoryBalance.findOne({ itemId: item._id, location: 'Kitchen Store' })
      .then((balance) => balance.quantity)).toBe(5);

    const cancelled = await invoke(cancelStockTransfer, requestFor({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      params: { id: String(transfer.movements[0]._id) },
      body: { notes: 'Undo transfer' }
    }));
    expect(cancelled.body.success).toBe(true);
    expect(await InventoryBalance.findOne({ itemId: item._id, location: 'Main Store' })
      .then((balance) => balance.quantity)).toBe(20);
    expect(await InventoryBalance.findOne({ itemId: item._id, location: 'Kitchen Store' })
      .then((balance) => balance.quantity)).toBe(0);

    const again = await invoke(cancelStockTransfer, requestFor({
      hotelId: isolatedHotelId,
      propertyId: isolatedPropertyId,
      params: { id: 'TRF-CANCEL-TEST' }
    }));
    expect(again.body.data.duplicate).toBe(true);
  });
});
