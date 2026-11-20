import mongoose from 'mongoose';
import {
  Hotel, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, MenuItem,
  PreparedFoodMovement, ProductionBatch, PurchaseOrder, RecipeConsumption, StockMovement, Unit, Vendor
} from '../models/index.js';
import {
  convertQuantityToBase, getStandardUnitConversionFactor, normalizeInventoryUnit
} from '../config/inventoryUnits.js';
import { generateReference } from '../utils/reference.js';
import { resolveStorageLocation } from './storageLocationService.js';

const round = (value) => Math.round((value + Number.EPSILON) * 10000) / 10000;
const roundQuantity = (value) => Math.round((value + Number.EPSILON) * 100000000) / 100000000;
const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const OPEN_PURCHASE_ORDER_STATUSES = [
  'draft', 'pending_approval', 'approved', 'ordered', 'partially_received'
];
const BASE_UNIT_CONFIGURATION_ERROR =
  'Base unit is not configured for this raw material. Please configure the base unit before adding stock.';
const RAW_MATERIAL_CONVERSION_ERROR =
  'Unit conversion configuration is invalid for this raw material. Please correct it before adding stock.';

export const getRawMaterialUnitConfigurationStatus = async ({ item, hotelId, session }) => {
  if (item.inventoryType !== 'raw_material') return { valid: true };
  if (!mongoose.isValidObjectId(item.baseUnitId)) {
    return { valid: false, message: BASE_UNIT_CONFIGURATION_ERROR };
  }

  const baseUnit = await Unit.findOne({
    _id: item.baseUnitId?._id || item.baseUnitId,
    hotelId,
    isActive: true
  }).select('_id symbol category').session(session);
  if (!baseUnit || normalizeInventoryUnit(item.baseUnit || item.unit) !== normalizeInventoryUnit(baseUnit.symbol)) {
    return { valid: false, message: BASE_UNIT_CONFIGURATION_ERROR };
  }
  if (!['weight', 'volume', 'quantity'].includes(baseUnit.category)) {
    return { valid: false, message: RAW_MATERIAL_CONVERSION_ERROR };
  }

  const supportedUnits = item.supportedUnits || [];
  const baseEntry = supportedUnits.find((entry) => (
    String(entry.unitId?._id || entry.unitId || '') === String(baseUnit._id)
    && entry.isActive !== false
  ));
  if (!baseEntry || !Number.isFinite(Number(baseEntry.conversionFactorToBase))
    || Math.abs(Number(baseEntry.conversionFactorToBase) - 1) > 1e-9) {
    return { valid: false, message: RAW_MATERIAL_CONVERSION_ERROR };
  }

  const activeEntries = supportedUnits.filter((entry) => entry.isActive !== false);
  const unitIds = [...new Set(activeEntries.map((entry) => (
    String(entry.unitId?._id || entry.unitId || '')
  )).concat(activeEntries.map((entry) => String(
    entry.packageMeasurementUnitId?._id || entry.packageMeasurementUnitId || ''
  ))).filter(Boolean))];
  const units = await Unit.find({
    hotelId,
    isActive: true,
    _id: { $in: unitIds }
  }).select('_id symbol category baseUnitId conversionFactor').session(session);
  const unitsById = new Map(units.map((unit) => [String(unit._id), unit]));
  if (unitIds.some((id) => !unitsById.has(id))) {
    return { valid: false, message: RAW_MATERIAL_CONVERSION_ERROR };
  }
  const entriesByUnitId = new Map(supportedUnits.map((entry) => [
    String(entry.unitId?._id || entry.unitId || ''),
    entry
  ]));
  const resolveConfiguredFactor = (entry, path = new Set()) => {
    const unitId = String(entry.unitId?._id || entry.unitId || '');
    if (path.has(unitId)) return null;
    const unit = unitsById.get(unitId);
    if (!unit) return null;
    if (unit.category !== 'package') {
      return getStandardUnitConversionFactor(baseUnit, unit);
    }
    const packageSize = Number(entry.packageSize);
    const measurementId = String(entry.packageMeasurementUnitId?._id || entry.packageMeasurementUnitId || '');
    const measurement = unitsById.get(measurementId);
    const measurementEntry = entriesByUnitId.get(measurementId);
    if (!Number.isFinite(packageSize) || packageSize <= 0 || !measurement) return null;
    const nextPath = new Set(path);
    nextPath.add(unitId);
    const measurementFactor = measurement.category === 'package'
      ? measurementEntry && resolveConfiguredFactor(measurementEntry, nextPath)
      : getStandardUnitConversionFactor(baseUnit, measurement);
    return Number.isFinite(measurementFactor) && measurementFactor > 0
      ? packageSize * measurementFactor
      : null;
  };
  for (const entry of activeEntries) {
    const unit = unitsById.get(String(entry.unitId?._id || entry.unitId || ''));
    const factor = Number(entry.conversionFactorToBase);
    const configuredFactor = resolveConfiguredFactor(entry);
    if (!Number.isFinite(factor) || factor <= 0
      || !Number.isFinite(configuredFactor) || configuredFactor <= 0
      || Math.abs(factor - configuredFactor) > 1e-9) {
      return { valid: false, message: RAW_MATERIAL_CONVERSION_ERROR };
    }
  }

  return { valid: true, baseUnit };
};

export const requireRawMaterialUnitConfiguration = async ({ item, hotelId, session }) => {
  const status = await getRawMaterialUnitConfigurationStatus({ item, hotelId, session });
  if (!status.valid) {
    throw Object.assign(new Error(status.message), { statusCode: 400 });
  }
  return status;
};

export const resolveRawMaterialPurchaseUnit = async ({
  item,
  hotelId,
  purchaseUnitId,
  purchaseUnit,
  purchasePackageId,
  conversionFactor,
  allowConversionSnapshot = false,
  session
}) => {
  const { baseUnit } = await requireRawMaterialUnitConfiguration({ item, hotelId, session });
  if (allowConversionSnapshot
    && (!Number.isFinite(Number(conversionFactor)) || Number(conversionFactor) <= 0)) {
    throw Object.assign(new Error(RAW_MATERIAL_CONVERSION_ERROR), { statusCode: 400 });
  }
  const supportedUnits = item.supportedUnits || [];
  let entry = purchasePackageId
    ? supportedUnits.find((candidate) => (
      candidate.isActive !== false && String(candidate._id) === String(purchasePackageId)
    ))
    : null;
  if (!entry && !purchasePackageId && purchaseUnitId) {
    const matchingUnits = supportedUnits.filter((candidate) => (
      candidate.isActive !== false
      && String(candidate.unitId?._id || candidate.unitId || '') === String(purchaseUnitId)
    ));
    entry = matchingUnits.find((candidate) => candidate.isDefaultPurchaseUnit)
      || matchingUnits.find((candidate) => (
        normalizeInventoryUnit(candidate.unitSymbolSnapshot || '') === normalizeInventoryUnit(purchaseUnit || '')
      ))
      || matchingUnits[0];
  }
  if (!entry && !purchasePackageId && !purchaseUnitId) {
    entry = supportedUnits.find((candidate) => (
      candidate.isActive !== false
      && normalizeInventoryUnit(candidate.unitSymbolSnapshot || '') === normalizeInventoryUnit(purchaseUnit || '')
    ));
  }
  if (!entry || !Number.isFinite(Number(entry.conversionFactorToBase))
    || Number(entry.conversionFactorToBase) <= 0) {
    throw Object.assign(new Error(`Choose a valid purchase unit configured for ${item.name}.`), { statusCode: 400 });
  }

  const configuredUnitId = entry.unitId?._id || entry.unitId;
  const unit = await Unit.findOne({
    _id: configuredUnitId,
    hotelId,
    isActive: true
  }).select('_id symbol category').session(session);
  if (!unit || normalizeInventoryUnit(unit.symbol) !== normalizeInventoryUnit(entry.unitSymbolSnapshot || unit.symbol)) {
    throw Object.assign(new Error(RAW_MATERIAL_CONVERSION_ERROR), { statusCode: 400 });
  }
  if (conversionFactor !== undefined && conversionFactor !== null
    && (!Number.isFinite(Number(conversionFactor))
      || (!allowConversionSnapshot
        && Math.abs(Number(conversionFactor) - Number(entry.conversionFactorToBase)) > 1e-9))) {
    throw Object.assign(new Error(RAW_MATERIAL_CONVERSION_ERROR), { statusCode: 400 });
  }
  if (String(unit._id) === String(baseUnit._id)
    && Math.abs(Number(entry.conversionFactorToBase) - 1) > 1e-9) {
    throw Object.assign(new Error(RAW_MATERIAL_CONVERSION_ERROR), { statusCode: 400 });
  }
  return { entry, unit, baseUnit, conversionFactor: Number(entry.conversionFactorToBase) };
};
export const getInventoryBatchAverageCosts = async ({ hotelId, propertyId, itemIds, session }) => {
  const validItemIds = [...new Set(itemIds.map(String))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!validItemIds.length) return new Map();

  const pipeline = [
    {
      $match: {
        hotelId,
        ...(propertyId ? { propertyId } : {}),
        itemId: { $in: validItemIds },
        remainingQuantity: { $gt: 0 }
      }
    },
    {
      $group: {
        _id: '$itemId',
        quantity: { $sum: '$remainingQuantity' },
        value: { $sum: { $multiply: ['$remainingQuantity', '$unitCost'] } }
      }
    }
  ];
  const aggregation = InventoryBatch.aggregate(pipeline);
  if (session) aggregation.session(session);
  const batchCosts = await aggregation;
  return new Map(batchCosts.map((batch) => [
    String(batch._id),
    batch.quantity > 0 ? batch.value / batch.quantity : null
  ]));
};
const DEPARTMENT_STOCK_LOCATIONS = {
  Kitchen: 'Kitchen Store',
  Restaurant: 'Restaurant Store',
  Housekeeping: 'Housekeeping Store',
  Maintenance: 'Maintenance Store',
  Minibar: 'Minibar Store'
};

const recordPreparedFoodMovement = async ({
  batch, movementType, quantity, idempotencyKey, recordedBy, session, order = null,
  reason = '', notes = '', unitSellingPrice = null
}) => {
  const qty = roundQuantity(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) {
    throw Object.assign(new Error('Prepared food quantity must be greater than zero.'), { statusCode: 400 });
  }
  const counterField = {
    sale: 'soldQuantity',
    wastage: 'wastedQuantity',
    complimentary: 'complimentaryQuantity',
    unrecorded_consumption: 'unrecordedQuantity',
    staff_consumption: 'staffConsumptionQuantity',
    transfer_out: 'transferredOutQuantity'
  }[movementType];
  if (!counterField) {
    throw Object.assign(new Error('Unsupported prepared food movement.'), { statusCode: 400 });
  }
  const updated = await ProductionBatch.findOneAndUpdate({
    _id: batch._id,
    status: 'active',
    availableQuantity: { $gte: qty }
  }, {
    $inc: { availableQuantity: -qty, [counterField]: qty }
  }, { new: true, session });
  if (!updated) {
    throw Object.assign(new Error(`Insufficient prepared portions for ${batch.menuItemName} in batch ${batch.batchNumber}.`), { statusCode: 409 });
  }
  const totalCost = roundMoney(qty * batch.costPerPortion);
  const unitPrice = Number(batch.sellingPrice) || 0;
  const [movement] = await PreparedFoodMovement.create([{
    hotelId: batch.hotelId,
    propertyId: batch.propertyId,
    productionBatchId: batch._id,
    menuItemId: batch.menuItemId,
    movementType,
    quantity: qty,
    unitCost: batch.costPerPortion,
    totalCost,
    salesRevenue: movementType === 'sale'
      ? roundMoney(qty * (unitSellingPrice !== null && Number.isFinite(Number(unitSellingPrice))
        ? Number(unitSellingPrice)
        : unitPrice))
      : 0,
    orderId: order?._id || null,
    orderNumber: order?.orderNumber || '',
    idempotencyKey,
    reason,
    location: batch.location,
    locationId: batch.locationId,
    recordedBy,
    notes
  }], { session });
  return { batch: updated, movement, totalCost };
};

export const createProductionBatch = async ({
  hotelId,
  propertyId,
  recipeId,
  productionQuantity,
  acceptedQuantity = productionQuantity,
  productionMethod = 'recipe_based',
  ingredients = [],
  wastage = [],
  location = 'Kitchen Store',
  locationId,
  rawMaterialLocation = 'Main Store',
  rawMaterialLocationId,
  productionDate = new Date(),
  expiryDate = null,
  preparedBy = null,
  receivedBy = null,
  recordedBy,
  idempotencyKey,
  notes = ''
}, session) => {
  if (idempotencyKey) {
    const duplicate = await ProductionBatch.findOne({ hotelId, propertyId, idempotencyKey }).session(session);
    if (duplicate) return { batch: duplicate, duplicate: true };
  }
  const quantity = Number(productionQuantity);
  const accepted = Number(acceptedQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(accepted)
    || accepted <= 0 || accepted > quantity
    || !['recipe_based', 'actual_consumption'].includes(productionMethod)
    || !Array.isArray(ingredients) || !Array.isArray(wastage)) {
    throw Object.assign(new Error('Enter valid production and accepted quantities and a supported production method.'), { statusCode: 400 });
  }
  const recipe = await InventoryRecipe.findOne({
    _id: recipeId,
    hotelId,
    propertyId,
    isActive: true,
    productionMode: 'batch_production'
  }).session(session);
  if (!recipe) {
    throw Object.assign(new Error('Select an active batch-production recipe.'), { statusCode: 404 });
  }
  const menuItem = await MenuItem.findOne({
    _id: recipe.menuItemId,
    hotelId
  }).session(session);
  if (!menuItem) throw Object.assign(new Error('The recipe menu item no longer exists.'), { statusCode: 409 });
  const [productionStorageLocation, rawStorageLocation] = await Promise.all([
    resolveStorageLocation({ hotelId, locationId, locationName: location, session }),
    resolveStorageLocation({ hotelId, locationId: rawMaterialLocationId, locationName: rawMaterialLocation, session })
  ]);

  const productionAt = productionDate instanceof Date ? productionDate : new Date(productionDate);
  const expiryAt = expiryDate ? new Date(expiryDate) : null;
  if (Number.isNaN(productionAt.getTime()) || (expiryAt && Number.isNaN(expiryAt.getTime()))
    || (expiryAt && expiryAt < productionAt)) {
    throw Object.assign(new Error('Production and use-by dates must be valid; use-by cannot precede production.'), { statusCode: 400 });
  }
  const actualByItem = new Map(ingredients.map((line) => [String(line.itemId), line]));
  const wastageByItem = new Map(wastage.map((line) => [String(line.itemId), line]));
  if (actualByItem.size !== ingredients.length || wastageByItem.size !== wastage.length) {
    throw Object.assign(new Error('Each ingredient may be entered only once.'), { statusCode: 400 });
  }
  const recipeItemIds = new Set(recipe.ingredients.map((line) => String(line.itemId)));
  if ([...actualByItem.keys(), ...wastageByItem.keys()].some((itemId) => !recipeItemIds.has(itemId))) {
    throw Object.assign(new Error('Production quantities and wastage must refer only to ingredients in the selected recipe.'), { statusCode: 400 });
  }
  const batchNumber = generateReference('PRD');
  const consumedLines = [];
  const recipeBatchCosts = productionMethod === 'recipe_based'
    ? await getInventoryBatchAverageCosts({
      hotelId,
      propertyId,
      itemIds: recipe.ingredients.filter((line) => !line.optional).map((line) => line.itemId),
      session
    })
    : new Map();
  // Expected preparation loss is a planning allowance: required input = usable / (1 - loss%).
  // Do not apply this again when recording separate actual wastage lines.
  const yieldScale = 1 / Number(recipe.expectedProductionYield || 1);
  const lossFraction = (Number(recipe.expectedPreparationLossPercent) || 0) / 100;
  if (lossFraction >= 1) {
    throw Object.assign(new Error('Expected preparation loss must be less than 100%.'), { statusCode: 400 });
  }
  const lossScale = 1 / (1 - lossFraction);
  let productionCost = 0;
  let rawMaterialWastageCost = 0;
  for (const recipeIngredient of recipe.ingredients) {
    if (recipeIngredient.optional) continue;
    const item = await InventoryItem.findOne({
      _id: recipeIngredient.itemId,
      hotelId,
      propertyId,
      isActive: true
    }).session(session);
    if (!item) throw Object.assign(new Error('A recipe ingredient is no longer active.'), { statusCode: 409 });
    const enteredLine = actualByItem.get(String(item._id));
    if (productionMethod === 'actual_consumption' && !enteredLine) {
      throw Object.assign(new Error(`Enter actual consumption for ${item.name}.`), { statusCode: 400 });
    }
    const unit = normalizeInventoryUnit(enteredLine?.unit || recipeIngredient.unit || item.baseUnit || item.unit);
    const enteredQuantity = productionMethod === 'actual_consumption'
      ? Number(enteredLine.quantity)
      : Number(recipeIngredient.quantity) * quantity * yieldScale * lossScale;
    if (!Number.isFinite(enteredQuantity) || enteredQuantity < 0
      || (productionMethod === 'actual_consumption' && enteredQuantity <= 0)) {
      throw Object.assign(new Error(`Enter a valid actual quantity for ${item.name}.`), { statusCode: 400 });
    }
    const actualBase = convertQuantityToBase(
      item,
      enteredQuantity,
      unit,
      productionMethod === 'recipe_based' ? recipeIngredient.conversionFactor : undefined
    ).quantity;
    const theoreticalBase = roundQuantity(
      Number(recipeIngredient.quantity)
        * quantity * yieldScale * lossScale
        * Number(recipeIngredient.conversionFactor || 1)
    );
    const purchaseConversionFactor = Number(item.purchaseConversionFactor);
    const purchaseUnitCost = item.purchasePrice !== null && item.purchasePrice !== undefined
      && Number.isFinite(Number(item.purchasePrice))
      && Number.isFinite(purchaseConversionFactor)
      && purchaseConversionFactor > 0
      ? Number(item.purchasePrice) / purchaseConversionFactor
      : null;
    const storedUnitCost = Number(item.unitCost);
    const recipeUnitCost = recipeBatchCosts.has(String(item._id))
      ? recipeBatchCosts.get(String(item._id))
      : purchaseUnitCost ?? (
        Number.isFinite(storedUnitCost) && storedUnitCost > 0 ? storedUnitCost : null
      );
    const wastageLine = wastageByItem.get(String(item._id));
    const wastageEntered = Number(wastageLine?.quantity || 0);
    const wastageReason = String(wastageLine?.reason || '').trim();
    if (!Number.isFinite(wastageEntered) || wastageEntered < 0
      || (wastageEntered > 0 && !wastageReason)) {
      throw Object.assign(new Error(`A reason is required for raw material wastage of ${item.name}.`), { statusCode: 400 });
    }
    const wastageUnit = normalizeInventoryUnit(wastageLine?.unit || unit);
    const wastageBase = wastageEntered > 0
      ? convertQuantityToBase(item, wastageEntered, wastageUnit).quantity
      : 0;
    const consumptionMovement = await postStockMovement({
      hotelId,
      propertyId,
      itemId: item._id,
      movementType: 'issue',
      quantity: enteredQuantity,
      unit,
      location: rawStorageLocation.locationName,
      locationId: rawStorageLocation._id,
      department: 'Production',
      referenceNumber: batchNumber,
      notes: `Raw material consumed for ${recipe.recipeName || menuItem.name} production.`,
      recordedBy,
      idempotencyKey: idempotencyKey ? `production:${idempotencyKey}:${item._id}:consumption` : undefined,
      metadata: { source: 'food_production', recipeId: String(recipe._id), recipeVersion: recipe.version },
      session
    });
    let wastageMovement = null;
    let wastageCost = 0;
    if (wastageBase > 0) {
      const wastageResult = await postStockMovement({
        hotelId,
        propertyId,
        itemId: item._id,
        movementType: 'wastage',
        quantity: wastageEntered,
        unit: wastageUnit,
        location: rawStorageLocation.locationName,
        locationId: rawStorageLocation._id,
        department: 'Production',
        referenceNumber: `${batchNumber}-WASTE`,
        notes: `Production raw material wastage: ${wastageReason}`,
        recordedBy,
        idempotencyKey: idempotencyKey ? `production:${idempotencyKey}:${item._id}:wastage` : undefined,
        metadata: { source: 'food_production', recipeId: String(recipe._id), recipeVersion: recipe.version, reason: wastageReason },
        session
      });
      wastageMovement = wastageResult.movement;
      wastageCost = wastageResult.movement.totalValue;
    }
    const actualCost = consumptionMovement.movement.totalValue;
    const ingredientCost = productionMethod === 'recipe_based' && recipeUnitCost !== null
      ? theoreticalBase * recipeUnitCost
      : actualCost;
    productionCost += ingredientCost;
    rawMaterialWastageCost += wastageCost;
    consumedLines.push({
      itemId: item._id,
      itemName: item.name,
      theoreticalQuantity: theoreticalBase,
      actualQuantity: consumptionMovement.movement.quantity,
      wastageQuantity: wastageBase,
      unit: item.baseUnit || item.unit,
      conversionFactor: 1,
      unitCost: consumptionMovement.movement.quantity > 0
        ? ingredientCost / consumptionMovement.movement.quantity
        : 0,
      totalCost: roundMoney(ingredientCost),
      wastageCost,
      movementId: consumptionMovement.movement._id,
      wastageMovementId: wastageMovement?._id || null,
      wastageReason
    });
  }
  if (actualByItem.size !== recipe.ingredients.filter((line) => !line.optional).length
    && productionMethod === 'actual_consumption') {
    throw Object.assign(new Error('Actual consumption includes an ingredient not required by the active recipe.'), { statusCode: 400 });
  }
  const costPerPortion = accepted > 0 ? roundMoney(productionCost / accepted) : 0;
  const now = new Date();
  const [batch] = await ProductionBatch.create([{
    hotelId,
    propertyId,
    batchNumber,
    idempotencyKey,
    menuItemId: menuItem._id,
    menuItemName: menuItem.name,
    recipeId: recipe._id,
    recipeVersion: recipe.version,
    recipeName: recipe.recipeName,
    servingSize: recipe.servingSize,
    productionMethod,
    productionQuantity: quantity,
    acceptedQuantity: accepted,
    availableQuantity: accepted,
    ingredients: consumedLines,
    productionCost: roundMoney(productionCost),
    rawMaterialWastageCost: roundMoney(rawMaterialWastageCost),
    costPerPortion,
    sellingPrice: Number(menuItem.price) || 0,
    location: productionStorageLocation.locationName,
    locationId: productionStorageLocation._id,
    rawMaterialLocation: rawStorageLocation.locationName,
    rawMaterialLocationId: rawStorageLocation._id,
    productionDate: productionAt,
    receivedAt: now,
    expiryDate: expiryAt,
    preparedBy: preparedBy || recordedBy,
    receivedBy: receivedBy || recordedBy,
    notes
  }], { session });
  await PreparedFoodMovement.create([{
    hotelId,
    propertyId,
    productionBatchId: batch._id,
    menuItemId: menuItem._id,
    movementType: 'production_receipt',
    quantity: accepted,
    unitCost: costPerPortion,
    totalCost: roundMoney(accepted * costPerPortion),
    idempotencyKey: idempotencyKey ? `production:${idempotencyKey}:receipt` : undefined,
    location: batch.location,
    locationId: batch.locationId,
    recordedBy: recordedBy || null
  }], { session });
  return { batch, duplicate: false };
};

export const recordPreparedFoodUse = async ({
  hotelId, propertyId, productionBatchId, movementType, quantity, reason = '', notes = '', recordedBy,
  idempotencyKey
}, session) => {
  if (!['wastage', 'complimentary', 'unrecorded_consumption', 'staff_consumption', 'transfer_out'].includes(movementType)) {
    throw Object.assign(new Error('Unsupported prepared food use type.'), { statusCode: 400 });
  }
  if (['wastage', 'unrecorded_consumption'].includes(movementType) && !String(reason).trim()) {
    throw Object.assign(new Error(`A reason is required when recording prepared food ${movementType === 'wastage' ? 'wastage' : 'unrecorded use'}.`), { statusCode: 400 });
  }
  if (idempotencyKey) {
    const existing = await PreparedFoodMovement.findOne({
      hotelId, propertyId, idempotencyKey
    }).session(session);
    if (existing) return { movement: existing, duplicate: true };
  }
  const batch = await ProductionBatch.findOne({
    _id: productionBatchId,
    hotelId,
    propertyId,
    status: 'active'
  }).session(session);
  if (!batch) throw Object.assign(new Error('Active production batch not found.'), { statusCode: 404 });
  return { ...(await recordPreparedFoodMovement({
    batch,
    movementType,
    quantity,
    idempotencyKey,
    recordedBy,
    session,
    reason,
    notes
  })), duplicate: false };
};

export const recordDirectInventoryUsage = async ({
  hotelId,
  propertyId,
  targetType,
  targetId,
  usageType,
  quantity,
  reason = '',
  location = 'Main Store',
  recordedBy,
  idempotencyKey
}, session) => {
  if (!['complimentary', 'unrecorded_consumption'].includes(usageType)) {
    throw Object.assign(new Error('Choose complimentary or unrecorded usage.'), { statusCode: 400 });
  }
  if (!['menu_item', 'raw_material'].includes(targetType)
    || !mongoose.isValidObjectId(targetId)) {
    throw Object.assign(new Error('Choose a valid menu item or raw material.'), { statusCode: 400 });
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw Object.assign(new Error('Usage quantity must be greater than zero.'), { statusCode: 400 });
  }
  if (!String(reason).trim()) {
    throw Object.assign(new Error('A reason is required for complimentary or unrecorded usage.'), { statusCode: 400 });
  }
  if (!idempotencyKey || idempotencyKey.length > 100) {
    throw Object.assign(new Error('A valid usage request key is required.'), { statusCode: 400 });
  }

  const source = usageType === 'complimentary'
    ? 'manual_complimentary_usage'
    : 'manual_unrecorded_usage';
  const existing = await StockMovement.findOne({
    hotelId,
    propertyId,
    'metadata.directUsage.usageId': idempotencyKey
  }).session(session).lean();
  if (existing) {
    const movements = await StockMovement.find({
      hotelId,
      propertyId,
      'metadata.directUsage.usageId': idempotencyKey
    }).session(session).populate('itemId', 'name unit baseUnit').lean();
    return { movements, duplicate: true };
  }

  let targetName;
  let targetUnit;
  let usageLocation = location || 'Main Store';
  let recipeVersion = null;
  let lines;
  if (targetType === 'raw_material') {
    const item = await InventoryItem.findOne({
      _id: targetId,
      hotelId,
      propertyId,
      inventoryType: 'raw_material',
      isActive: true
    }).session(session);
    if (!item) throw Object.assign(new Error('Active raw material not found.'), { statusCode: 404 });
    targetName = item.name;
    targetUnit = item.baseUnit || item.unit;
    lines = [{
      itemId: item._id,
      quantity: qty,
      unit: targetUnit,
      conversionFactor: 1
    }];
  } else {
    const recipe = await InventoryRecipe.findOne({
      _id: targetId,
      hotelId,
      propertyId,
      isActive: true,
      productionMode: 'made_to_order'
    }).session(session);
    if (!recipe) {
      throw Object.assign(new Error('Select an active made-to-order recipe. Batch-production menu items must be recorded from their prepared batch.'), { statusCode: 404 });
    }
    const menuItem = await MenuItem.findOne({ _id: recipe.menuItemId, hotelId }).session(session);
    if (!menuItem) throw Object.assign(new Error('The menu item for this recipe could not be found.'), { statusCode: 404 });
    targetName = menuItem.name;
    targetUnit = recipe.servingSize || 'portion';
    usageLocation = recipe.location || usageLocation;
    recipeVersion = recipe.version;
    const yieldQuantity = Number(recipe.expectedProductionYield) || 1;
    lines = recipe.ingredients
      .filter((ingredient) => !ingredient.optional)
      .map((ingredient) => ({
        itemId: ingredient.itemId,
        quantity: Number(ingredient.quantity) * qty / yieldQuantity,
        unit: ingredient.unit,
        conversionFactor: ingredient.conversionFactor
      }));
    if (!lines.length) throw Object.assign(new Error('The selected recipe has no required ingredients to deduct.'), { statusCode: 400 });
  }

  const usageSnapshot = {
    usageId: idempotencyKey,
    usageType,
    targetType,
    targetId: String(targetId),
    targetName,
    targetQuantity: qty,
    targetUnit,
    reason: String(reason).trim(),
    recipeVersion
  };
  const movements = [];
  for (const [index, line] of lines.entries()) {
    const item = await InventoryItem.findOne({
      _id: line.itemId,
      hotelId,
      propertyId,
      isActive: true
    }).session(session);
    if (!item) throw Object.assign(new Error('A selected usage item is no longer active.'), { statusCode: 409 });
    const movementResult = await postStockMovement({
      hotelId,
      propertyId,
      itemId: item._id,
      movementType: 'issue',
      quantity: line.quantity,
      unit: line.unit || item.baseUnit || item.unit,
      conversionFactor: line.conversionFactor || undefined,
      location: usageLocation,
      department: 'Restaurant',
      referenceNumber: `USAGE-${idempotencyKey.slice(-12)}`,
      notes: `${usageType === 'complimentary' ? 'Complimentary' : 'Unrecorded'} ${targetType === 'menu_item' ? 'menu item' : 'raw material'} usage: ${targetName}. ${String(reason).trim()}`,
      recordedBy,
      idempotencyKey: `${idempotencyKey}:${index}`,
      metadata: {
        source,
        directUsage: usageSnapshot
      },
      session
    });
    movements.push(movementResult.movement);
  }
  return {
    movements,
    duplicate: false,
    totalCost: roundMoney(movements.reduce((sum, movement) => sum + Number(movement.totalValue || 0), 0)),
    usage: usageSnapshot
  };
};

export const transferPreparedFood = async ({
  hotelId, propertyId, productionBatchId, quantity, destinationLocation, destinationLocationId,
  recordedBy, idempotencyKey, notes = ''
}, session) => {
  const existingMovement = await PreparedFoodMovement.findOne({
    hotelId,
    propertyId,
    idempotencyKey,
    movementType: 'transfer_out'
  }).session(session);
  if (existingMovement) {
    const incoming = await PreparedFoodMovement.findOne({
      hotelId,
      propertyId,
      idempotencyKey: `${idempotencyKey}:in`,
      movementType: 'transfer_in'
    }).session(session);
    const sourceBatch = await ProductionBatch.findOne({ _id: productionBatchId, hotelId, propertyId }).session(session);
    const targetBatch = incoming
      ? await ProductionBatch.findOne({
        _id: incoming.productionBatchId,
        hotelId,
        propertyId
      }).session(session)
      : null;
    return { sourceBatch, targetBatch, duplicate: true };
  }
  const transferQuantity = roundQuantity(Number(quantity));
  const destinationStorageLocation = await resolveStorageLocation({
    hotelId,
    locationId: destinationLocationId,
    locationName: destinationLocation,
    session
  });
  const destination = destinationStorageLocation.locationName;
  if (!Number.isFinite(transferQuantity) || transferQuantity <= 0 || !destination) {
    throw Object.assign(new Error('Enter a positive transfer quantity and destination location.'), { statusCode: 400 });
  }
  const sourceBatch = await ProductionBatch.findOne({
    _id: productionBatchId,
    hotelId,
    propertyId,
    status: 'active'
  }).session(session);
  if (!sourceBatch) throw Object.assign(new Error('Active production batch not found.'), { statusCode: 404 });
  if ((sourceBatch.locationId && String(sourceBatch.locationId) === String(destinationStorageLocation._id))
    || (!sourceBatch.locationId && sourceBatch.location === destination)) {
    throw Object.assign(new Error('Choose a destination different from the current batch location.'), { statusCode: 400 });
  }
  const movedSource = await ProductionBatch.findOneAndUpdate({
    _id: sourceBatch._id,
    status: 'active',
    availableQuantity: { $gte: transferQuantity }
  }, {
    $inc: { availableQuantity: -transferQuantity, transferredOutQuantity: transferQuantity }
  }, { new: true, session });
  if (!movedSource) {
    throw Object.assign(new Error(`Insufficient prepared portions in batch ${sourceBatch.batchNumber}.`), { statusCode: 409 });
  }
  const receivedAt = new Date();
  const [targetBatch] = await ProductionBatch.create([{
    hotelId,
    propertyId,
    batchNumber: generateReference('PRD'),
    idempotencyKey: `transfer:${idempotencyKey}`,
    menuItemId: sourceBatch.menuItemId,
    menuItemName: sourceBatch.menuItemName,
    recipeId: sourceBatch.recipeId,
    recipeVersion: sourceBatch.recipeVersion,
    recipeName: sourceBatch.recipeName,
    servingSize: sourceBatch.servingSize,
    productionMethod: sourceBatch.productionMethod,
    productionQuantity: transferQuantity,
    acceptedQuantity: transferQuantity,
    availableQuantity: transferQuantity,
    ingredients: [],
    productionCost: 0,
    costPerPortion: sourceBatch.costPerPortion,
    sellingPrice: sourceBatch.sellingPrice,
    location: destination,
    locationId: destinationStorageLocation._id,
    productionDate: sourceBatch.productionDate,
    receivedAt,
    expiryDate: sourceBatch.expiryDate,
    preparedBy: sourceBatch.preparedBy,
    receivedBy: recordedBy,
    isTransferBatch: true,
    transferredFromBatchId: sourceBatch._id,
    notes: notes || `Transferred from ${sourceBatch.location}.`
  }], { session });
  const unitCost = sourceBatch.costPerPortion;
  const totalCost = roundMoney(transferQuantity * unitCost);
  const movements = await PreparedFoodMovement.create([
    {
      hotelId,
      propertyId,
      productionBatchId: sourceBatch._id,
      menuItemId: sourceBatch.menuItemId,
      movementType: 'transfer_out',
      quantity: transferQuantity,
      unitCost,
      totalCost,
      idempotencyKey,
      reason: notes,
      location: sourceBatch.location,
      locationId: sourceBatch.locationId,
      destinationLocation: destination,
      destinationLocationId: destinationStorageLocation._id,
      recordedBy
    },
    {
      hotelId,
      propertyId,
      productionBatchId: targetBatch._id,
      menuItemId: sourceBatch.menuItemId,
      movementType: 'transfer_in',
      quantity: transferQuantity,
      unitCost,
      totalCost,
      idempotencyKey: `${idempotencyKey}:in`,
      reason: notes,
      location: destination,
      locationId: destinationStorageLocation._id,
      destinationLocation: sourceBatch.location,
      destinationLocationId: sourceBatch.locationId,
      recordedBy
    }
  ], { session, ordered: true });
  return { sourceBatch: movedSource, targetBatch, movements, duplicate: false };
};

const reverseProductionStockMovement = async (movement, batch, recordedBy, session) => {
  const item = await InventoryItem.findOneAndUpdate({
    _id: movement.itemId,
    hotelId: batch.hotelId,
    propertyId: batch.propertyId
  }, { $inc: { currentStock: movement.quantity } }, { new: true, session });
  if (!item) {
    throw Object.assign(new Error('A production ingredient could not be restored because its inventory item is missing.'), { statusCode: 409 });
  }
  const balance = await updateBalance({
    hotelId: batch.hotelId,
    propertyId: batch.propertyId,
    item,
    location: movement.location,
    locationId: movement.locationId,
    delta: movement.quantity,
    session
  });
  for (const allocation of movement.batchAllocations || []) {
    if (!allocation.batchId) continue;
    const restoredBatch = await InventoryBatch.findOneAndUpdate({
      _id: allocation.batchId,
      hotelId: batch.hotelId,
      propertyId: batch.propertyId,
      itemId: movement.itemId,
      location: movement.location,
      $expr: { $lte: [{ $add: ['$remainingQuantity', allocation.quantity] }, '$quantity'] }
    }, { $inc: { remainingQuantity: allocation.quantity } }, { new: true, session });
    if (!restoredBatch) {
      throw Object.assign(new Error('A consumed raw-material batch could not be restored safely.'), { statusCode: 409 });
    }
  }
  await StockMovement.create([{
    hotelId: batch.hotelId,
    propertyId: batch.propertyId,
    itemId: movement.itemId,
    movementType: 'sale_reversal',
    quantity: movement.quantity,
    previousStock: roundQuantity(item.currentStock - movement.quantity),
    newStock: item.currentStock,
    unitCost: movement.unitCost,
    totalValue: movement.totalValue,
    referenceNumber: batch.batchNumber,
    notes: `Raw material restored after cancelling production batch ${batch.batchNumber}.`,
    recordedBy,
    location: movement.location,
    department: 'Production',
    idempotencyKey: `production-reversal:${batch._id}:${movement._id}`,
    batchAllocations: movement.batchAllocations,
    metadata: {
      source: 'food_production_reversal',
      reversedMovementId: movement._id,
      locationPreviousStock: balance.previous,
      locationNewStock: balance.current
    }
  }], { session });
  if (item.inventoryType === 'raw_material') {
    await evaluateAutomaticReorder({
      hotelId: batch.hotelId,
      propertyId: batch.propertyId,
      itemId: item._id,
      recordedBy,
      session
    });
  }
};

export const cancelProductionBatch = async ({
  hotelId, propertyId, productionBatchId, recordedBy, idempotencyKey
}, session) => {
  const priorReversal = await PreparedFoodMovement.findOne({
    hotelId,
    propertyId,
    productionBatchId,
    movementType: 'reversal',
    idempotencyKey
  }).session(session);
  const batch = await ProductionBatch.findOne({ _id: productionBatchId, hotelId, propertyId }).session(session);
  if (!batch) throw Object.assign(new Error('Production batch not found.'), { statusCode: 404 });
  if (priorReversal) return { batch, movement: priorReversal, duplicate: true };
  if (batch.status !== 'active') {
    throw Object.assign(new Error('Only active production batches can be cancelled.'), { statusCode: 409 });
  }
  const portionsWereUsed = Number(batch.reservedQuantity || 0) > 0
    || Number(batch.soldQuantity || 0) > 0
    || Number(batch.wastedQuantity || 0) > 0
    || Number(batch.complimentaryQuantity || 0) > 0
    || Number(batch.staffConsumptionQuantity || 0) > 0
    || Number(batch.transferredOutQuantity || 0) > 0
    || Number(batch.availableQuantity) !== Number(batch.acceptedQuantity);
  if (portionsWereUsed) {
    throw Object.assign(new Error('A production batch cannot be cancelled after portions were sold, wasted, consumed, or transferred.'), { statusCode: 409 });
  }
  const stockMovements = [];
  for (const ingredient of batch.ingredients) {
    for (const movementId of [ingredient.movementId, ingredient.wastageMovementId].filter(Boolean)) {
      const movement = await StockMovement.findOne({
        _id: movementId,
        hotelId,
        propertyId,
        'metadata.source': 'food_production'
      }).session(session);
      if (!movement) {
        throw Object.assign(new Error('Production stock history is incomplete; the batch cannot be safely reversed.'), { statusCode: 409 });
      }
      stockMovements.push(movement);
    }
  }
  for (const movement of stockMovements) {
    await reverseProductionStockMovement(movement, batch, recordedBy, session);
  }
  batch.status = 'cancelled';
  batch.availableQuantity = 0;
  await batch.save({ session });
  const [reversal] = await PreparedFoodMovement.create([{
    hotelId,
    propertyId,
    productionBatchId: batch._id,
    menuItemId: batch.menuItemId,
    movementType: 'reversal',
    quantity: batch.acceptedQuantity,
    unitCost: batch.costPerPortion,
    totalCost: roundMoney(batch.productionCost + batch.rawMaterialWastageCost),
    idempotencyKey,
    reason: 'Production cancelled before prepared portions were used.',
    location: batch.location,
    recordedBy
  }], { session });
  return { batch, movement: reversal, duplicate: false };
};

export const reservePreparedFoodForOrder = async (
  order, session, recordedBy = order.createdBy, startLineIndex = 0
) => {
  const menuItemIds = [...new Set(order.items.map((line) => String(line.menuItemId)))];
  const recipes = await InventoryRecipe.find({
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    menuItemId: { $in: menuItemIds },
    isActive: true,
    productionMode: 'batch_production'
  }).sort({ version: -1 }).session(session);
  const batchRecipeIds = new Set(recipes.map((recipe) => String(recipe.menuItemId)));
  for (const [orderLineIndex, orderLine] of order.items.entries()) {
    if (orderLineIndex < startLineIndex
      || (orderLine.fulfillmentSource !== 'batch_production'
        && !batchRecipeIds.has(String(orderLine.menuItemId)))) continue;
    const alreadyAllocated = (order.preparedFoodAllocations || [])
      .filter((allocation) => allocation.orderLineIndex === orderLineIndex)
      .reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0);
    let remaining = roundQuantity(Number(orderLine.quantity) - alreadyAllocated);
    if (remaining <= 0) continue;
    const eligibleBatches = await ProductionBatch.find({
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      menuItemId: orderLine.menuItemId,
      status: 'active',
      availableQuantity: { $gt: 0 },
      $or: [{ expiryDate: null }, { expiryDate: { $gt: new Date() } }]
    }).session(session);
    eligibleBatches.sort((left, right) => {
      const leftExpiry = left.expiryDate ? new Date(left.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      const rightExpiry = right.expiryDate ? new Date(right.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      return leftExpiry - rightExpiry
        || new Date(left.receivedAt).getTime() - new Date(right.receivedAt).getTime()
        || String(left._id).localeCompare(String(right._id));
    });
    const totalAvailable = eligibleBatches.reduce((sum, batch) => sum + batch.availableQuantity, 0);
    if (totalAvailable < remaining) {
      throw Object.assign(new Error(
        `Insufficient bulk-production portions of ${orderLine.name}. Available: ${totalAvailable}; requested: ${remaining}.`
      ), { statusCode: 409 });
    }
    for (const batch of eligibleBatches) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, batch.availableQuantity);
      const reservedBatch = await ProductionBatch.findOneAndUpdate({
        _id: batch._id,
        hotelId: order.hotelId,
        propertyId: order.propertyId,
        status: 'active',
        availableQuantity: { $gte: quantity }
      }, {
        $inc: { availableQuantity: -quantity, reservedQuantity: quantity }
      }, { new: true, session });
      if (!reservedBatch) {
        throw Object.assign(new Error(
          `Bulk-production portions of ${orderLine.name} were just reserved by another order. Refresh and retry.`
        ), { statusCode: 409 });
      }
      await PreparedFoodMovement.create([{
        hotelId: batch.hotelId,
        propertyId: batch.propertyId,
        productionBatchId: batch._id,
        menuItemId: batch.menuItemId,
        movementType: 'reservation',
        quantity,
        orderId: order._id,
        orderNumber: order.orderNumber,
        orderLineIndex,
        idempotencyKey: `prepared-food-reservation:${order._id}:${orderLineIndex}:${batch._id}`,
        reason: 'Prepared portion reserved for a restaurant order.',
        location: batch.location,
        recordedBy
      }], { session });
      order.preparedFoodAllocations.push({
        menuItemId: orderLine.menuItemId,
        productionBatchId: batch._id,
        quantity,
        orderLineIndex,
        status: 'reserved'
      });
      remaining = roundQuantity(remaining - quantity);
    }
  }
  if ((order.preparedFoodAllocations || []).some((allocation) => allocation.status === 'reserved')) {
    order.preparedFoodReservedAt ||= new Date();
  }
  return order.preparedFoodAllocations || [];
};

export const releasePreparedFoodReservationsForOrder = async (order, session, recordedBy = order.createdBy) => {
  for (const [allocationIndex, allocation] of (order.preparedFoodAllocations || []).entries()) {
    if (!['reserved', 'sold'].includes(allocation.status)) continue;
    const wasSold = allocation.status === 'sold';
    const batch = await ProductionBatch.findOneAndUpdate({
      _id: allocation.productionBatchId,
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      status: 'active',
      [wasSold ? 'soldQuantity' : 'reservedQuantity']: { $gte: allocation.quantity }
    }, {
      $inc: {
        [wasSold ? 'soldQuantity' : 'reservedQuantity']: -allocation.quantity,
        availableQuantity: allocation.quantity
      }
    }, { new: true, session });
    if (!batch) {
      throw Object.assign(new Error('A prepared-food portion could not be restored safely.'), { statusCode: 409 });
    }
    await PreparedFoodMovement.create([{
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      productionBatchId: allocation.productionBatchId,
      menuItemId: allocation.menuItemId,
      movementType: wasSold ? 'sale_reversal' : 'reservation_release',
      quantity: allocation.quantity,
      unitCost: wasSold ? batch.costPerPortion : 0,
      totalCost: wasSold ? roundMoney(allocation.quantity * batch.costPerPortion) : 0,
      orderId: order._id,
      orderNumber: order.orderNumber,
      orderLineIndex: allocation.orderLineIndex,
      idempotencyKey: `prepared-food-order-reversal:${order._id}:${allocationIndex}`,
      reason: wasSold
        ? 'Previously served prepared portion restored after order cancellation.'
        : 'Prepared portion reservation released after order cancellation.',
      location: batch.location,
      recordedBy
    }], { session });
    allocation.status = wasSold ? 'reversed' : 'released';
  }
};

export const consumePreparedFoodForOrder = async (order, session, recordedBy = order.createdBy) => {
  if (order.preparedFoodDeductedAt) return order.preparedFoodAllocations || [];
  if (!(order.preparedFoodAllocations || []).some((allocation) => allocation.status === 'reserved')) {
    await reservePreparedFoodForOrder(order, session, recordedBy);
  }
  for (const [allocationIndex, allocation] of (order.preparedFoodAllocations || []).entries()) {
    if (allocation.status !== 'reserved') continue;
    const batch = await ProductionBatch.findOneAndUpdate({
      _id: allocation.productionBatchId,
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      status: 'active',
      reservedQuantity: { $gte: allocation.quantity }
    }, {
      $inc: { reservedQuantity: -allocation.quantity, soldQuantity: allocation.quantity }
    }, { new: true, session });
    if (!batch) {
      throw Object.assign(new Error('A reserved prepared-food portion could not be marked as sold safely.'), { statusCode: 409 });
    }
    await PreparedFoodMovement.create([{
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      productionBatchId: allocation.productionBatchId,
      menuItemId: allocation.menuItemId,
      movementType: 'sale',
      quantity: allocation.quantity,
      unitCost: batch.costPerPortion,
      totalCost: roundMoney(allocation.quantity * batch.costPerPortion),
      salesRevenue: 0,
      orderId: order._id,
      orderNumber: order.orderNumber,
      orderLineIndex: allocation.orderLineIndex,
      idempotencyKey: `prepared-food-sale:${order._id}:${allocationIndex}:${allocation.productionBatchId}`,
      reason: 'Reserved prepared portions served to the restaurant order.',
      location: batch.location,
      recordedBy
    }], { session });
    allocation.status = 'sold';
  }
  order.preparedFoodDeductedAt = new Date();
  return order.preparedFoodAllocations || [];
};

export const evaluateAutomaticReorder = async ({
  hotelId, propertyId, itemId, recordedBy = null, session
}) => {
  const item = await InventoryItem.findOne({
    _id: itemId,
    hotelId,
    propertyId,
    isActive: true,
    inventoryType: 'raw_material'
  }).session(session);
  if (!item) return null;

  const reorderLevel = Number(item.reorderLevel) > 0
    ? Number(item.reorderLevel)
    : Number(item.minStockThreshold || 0);
  if (reorderLevel <= 0) return null;

  const expiredBatches = await InventoryBatch.find({
    hotelId,
    propertyId,
    itemId: item._id,
    expiryDate: { $lte: new Date() },
    remainingQuantity: { $gt: 0 }
  }).select('remainingQuantity').session(session).lean();
  const openOrders = await PurchaseOrder.find({
    hotelId,
    propertyId,
    status: { $in: OPEN_PURCHASE_ORDER_STATUSES },
    'items.itemId': item._id
  }).select('items autoReorderItemId').session(session).lean();
  const currentAutoOrder = await PurchaseOrder.findOne({
    hotelId,
    propertyId,
    autoReorderItemId: item._id,
    status: 'draft'
  }).session(session);
  const expiredQuantity = expiredBatches.reduce((sum, batch) => sum + batch.remainingQuantity, 0);
  const availableStock = Math.max(0, Number(item.currentStock || 0) - expiredQuantity);
  const pendingPurchaseQuantity = openOrders.reduce((sum, order) => {
    if (currentAutoOrder && String(order._id) === String(currentAutoOrder._id)) return sum;
    return sum + order.items.reduce((lineTotal, line) => (
      String(line.itemId) === String(item._id)
        ? lineTotal + Math.max(0, Number(line.quantity || 0) - Number(line.receivedQuantity || 0))
          * Number(line.conversionFactor || 1)
        : lineTotal
    ), 0);
  }, 0);
  const targetStock = Math.max(
    reorderLevel,
    Number(item.maxStockLevel) > 0
      ? Number(item.maxStockLevel)
      : Number(item.reorderQuantity || 0)
  );
  const neededBaseQuantity = Math.max(0, targetStock - availableStock - pendingPurchaseQuantity);

  if (availableStock > reorderLevel || neededBaseQuantity <= 0) {
    if (currentAutoOrder) {
      currentAutoOrder.status = 'cancelled';
      currentAutoOrder.autoReorderItemId = null;
      currentAutoOrder.notes = `${currentAutoOrder.notes || ''}\nAutomatically cancelled after stock was re-evaluated.`.trim();
      await currentAutoOrder.save({ session });
    }
    return null;
  }

  const activeSupportedUnits = (item.supportedUnits || []).filter((unit) => unit.isActive !== false);
  if (item.inventoryType === 'raw_material') {
    const unitStatus = await getRawMaterialUnitConfigurationStatus({ item, hotelId, session });
    if (!unitStatus.valid) return null;
  }
  const preferredUnitId = String(item.preferredPurchaseUnitId || item.purchaseUnitId || '');
  const configuredPurchaseUnit = activeSupportedUnits.find((unit) => (
    unit.isActive !== false
    && String(unit.unitId?._id || unit.unitId || '') === preferredUnitId
    && unit.isDefaultPurchaseUnit
  )) || activeSupportedUnits.find((unit) => (
    String(unit.unitId?._id || unit.unitId || '') === preferredUnitId
  )) || activeSupportedUnits.find((unit) => unit.isDefaultPurchaseUnit);
  const purchaseUnit = configuredPurchaseUnit?.unitSymbolSnapshot
    || item.purchaseUnit
    || item.baseUnit
    || item.unit;
  const conversionFactor = Number(configuredPurchaseUnit?.conversionFactorToBase)
    || Number(item.purchaseConversionFactor)
    || 1;
  const packageConfigured = Number(configuredPurchaseUnit?.packageSize) > 0
    && Boolean(configuredPurchaseUnit?.packageMeasurementUnitId);
  if (item.inventoryType === 'raw_material') {
    await resolveRawMaterialPurchaseUnit({
      item,
      hotelId,
      purchaseUnitId: configuredPurchaseUnit?.unitId?._id || configuredPurchaseUnit?.unitId,
      purchaseUnit,
      purchasePackageId: configuredPurchaseUnit?._id,
      conversionFactor,
      session
    });
  }
  const purchaseQuantity = packageConfigured
    ? Math.ceil(neededBaseQuantity / conversionFactor)
    : roundQuantity(neededBaseQuantity / conversionFactor);
  const unitCost = Number(item.purchasePrice ?? (Number(item.unitCost || 0) * conversionFactor));
  if (!Number.isFinite(unitCost) || unitCost < 0) return null;
  const totalAmount = round(purchaseQuantity * unitCost);
  const line = {
    itemId: item._id,
    itemName: item.name,
    quantity: purchaseQuantity,
    receivedQuantity: 0,
    unit: purchaseUnit,
    unitId: configuredPurchaseUnit?.unitId?._id || configuredPurchaseUnit?.unitId || item.preferredPurchaseUnitId || item.purchaseUnitId || null,
    purchasePackageId: packageConfigured ? configuredPurchaseUnit._id : null,
    packageNameSnapshot: packageConfigured ? configuredPurchaseUnit.packageName || configuredPurchaseUnit.unitNameSnapshot : '',
    unitNameSnapshot: packageConfigured
      ? configuredPurchaseUnit.packageName || configuredPurchaseUnit.unitNameSnapshot
      : configuredPurchaseUnit?.unitNameSnapshot || purchaseUnit,
    unitSymbolSnapshot: purchaseUnit,
    conversionFactor,
    baseUnit: item.baseUnit || item.unit,
    baseUnitId: item.baseUnitId || null,
    baseUnitNameSnapshot: item.baseUnit || item.unit,
    baseUnitSymbolSnapshot: item.baseUnit || item.unit,
    unitCost,
    totalAmount
  };
  const preferredVendor = item.vendorId
    ? await Vendor.findOne({ _id: item.vendorId, hotelId, status: 'active' }).select('_id').session(session)
    : await Vendor.findOne({
      hotelId,
      status: 'active',
      suppliedItems: item._id
    }).select('_id').session(session);
  const poNumber = generateReference('PO');
  const update = {
    $set: {
      ...(preferredVendor ? { vendorId: preferredVendor._id } : {}),
      items: [line],
      subtotal: totalAmount,
      taxAmount: 0,
      discountAmount: 0,
      totalAmount,
      notes: 'Automatically generated from the reorder level. Pending manager review.',
      autoGenerated: true
    },
    $setOnInsert: {
      hotelId,
      propertyId,
      poNumber,
      autoReorderItemId: item._id,
      createdBy: recordedBy,
      department: ''
    }
  };
  if (!preferredVendor) update.$unset = { vendorId: 1 };
  const po = await PurchaseOrder.findOneAndUpdate({
    hotelId,
    propertyId,
    autoReorderItemId: item._id,
    status: 'draft'
  }, update, {
    new: true,
    upsert: true,
    runValidators: true,
    setDefaultsOnInsert: true,
    session
  });
  return po;
};
const unitIdForSymbol = (item, symbol) => {
  if (item.baseUnit === symbol) return item.baseUnitId || null;
  if (item.purchaseUnit === symbol) return item.purchaseUnitId || null;
  const packageOption = (item.packagingOptions || []).find((option) => option.unit === symbol);
  return packageOption?.unitId || (item.additionalPackagingOptions || [])
    .find((option) => String(option.unitId?.symbol || '') === symbol)?.unitId || null;
};

const updateBalance = async ({ hotelId, propertyId, item, location, locationId, delta, session }) => {
  let balance = locationId
    ? await InventoryBalance.findOne({
      hotelId, propertyId, itemId: item._id, locationId
    }).session(session)
    : null;
  balance ||= await InventoryBalance.findOne({
    hotelId, propertyId, itemId: item._id, location
  }).session(session);

  if (!balance) {
    balance = await InventoryBalance.create([{
      hotelId,
      propertyId,
      itemId: item._id,
      location,
      locationId,
      quantity: location === 'Main Store' ? item.currentStock : 0
    }], { session }).then(([created]) => created);
  } else if (locationId && !balance.locationId) {
    balance.locationId = locationId;
    await balance.save({ session });
  }

  const updated = await InventoryBalance.findOneAndUpdate({
    _id: balance._id,
    quantity: delta < 0 ? { $gte: Math.abs(delta) } : { $gte: 0 }
  }, { $inc: { quantity: delta } }, { new: true, session });
  if (!updated) {
    throw Object.assign(new Error(`Insufficient stock at ${location} for ${item.name}.`), { statusCode: 409 });
  }
  return { previous: roundQuantity(updated.quantity - delta), current: roundQuantity(updated.quantity) };
};

export const postStockMovement = async ({
  hotelId,
  propertyId,
  itemId,
  movementType,
  quantity,
  unit,
  batchIds,
  unitId,
  conversionFactor,
  purchasePackageId = null,
  purchasePackageName = '',
  purchasePackageSnapshot = false,
  packageQuantity = null,
  looseQuantity = 0,
  unitCost: unitCostOverride,
  purchaseUnitPrice = null,
  purchaseTaxAmount: purchaseTaxAmountOverride = null,
  purchaseDiscountAmount: purchaseDiscountAmountOverride = null,
  taxPercent = null,
  discountPercent = null,
  vendorId = null,
  autoGenerateBatchNumber = false,
  location = 'Main Store',
  locationId,
  department = '',
  referenceNumber = '',
  notes = '',
  recordedBy,
  transactionDate = null,
  idempotencyKey,
  orderId = null,
  batchNumber = '',
  expiryDate = null,
  batchDetails = {},
  receivedAt = null,
  metadata = {},
  session
}) => {
  let numericQuantity = Number(quantity);
  const isStockCount = movementType === 'adjustment' || movementType === 'physical_count';

  if (idempotencyKey) {
    const existing = await StockMovement.findOne({ hotelId, propertyId, idempotencyKey }).session(session);
    if (existing) return { movement: existing, duplicate: true };
  }

  const item = await InventoryItem.findOne({ _id: itemId, hotelId, propertyId, isActive: true }).session(session);
  if (!item) throw Object.assign(new Error('Active inventory item not found.'), { statusCode: 404 });
  if (item.inventoryType === 'raw_material'
    && ['receipt', 'return', 'opening', 'adjustment', 'physical_count'].includes(movementType)) {
    await requireRawMaterialUnitConfiguration({ item, hotelId, session });
  }
  const storageLocation = await resolveStorageLocation({
    hotelId,
    locationId,
    locationName: location,
    session
  });
  location = storageLocation.locationName;
  locationId = storageLocation._id;
  const hasPackageQuantity = packageQuantity !== null && packageQuantity !== undefined;
  if ((purchasePackageId && !hasPackageQuantity && !purchasePackageSnapshot)
    || (hasPackageQuantity && !purchasePackageId)) {
    throw Object.assign(new Error('A configured package and package quantity must be provided together.'), { statusCode: 400 });
  }
  const purchasePackage = purchasePackageId && hasPackageQuantity
    ? item.supportedUnits.id(String(purchasePackageId))
    : null;
  let enteredQuantity = numericQuantity;
  let enteredUnit = purchasePackageName || unit || item.baseUnit || item.unit;
  let conversionFactorOverride = conversionFactor;
  let recordedLooseQuantity = 0;
  let configuredUnitId = unitId || unitIdForSymbol(item, enteredUnit);
  if (purchasePackageId && hasPackageQuantity) {
    const packageCount = Number(packageQuantity);
    recordedLooseQuantity = Number(looseQuantity);
    if (movementType !== 'receipt' || item.inventoryType !== 'raw_material'
      || !purchasePackage || purchasePackage.isActive === false
      || !(Number(purchasePackage.packageSize) > 0)
      || !purchasePackage.packageMeasurementUnitId
      || !Number.isFinite(packageCount) || packageCount < 0
      || !Number.isFinite(recordedLooseQuantity) || recordedLooseQuantity < 0
      || (packageCount === 0 && recordedLooseQuantity === 0)
      || !(Number(purchasePackage.conversionFactorToBase) > 0)) {
      throw Object.assign(new Error('Choose a configured package and enter a positive package or loose quantity.'), { statusCode: 400 });
    }
    enteredQuantity = packageCount;
    enteredUnit = purchasePackage.packageName || purchasePackage.unitNameSnapshot;
    conversionFactorOverride = Number(purchasePackage.conversionFactorToBase);
    numericQuantity = packageCount * conversionFactorOverride + recordedLooseQuantity;
    if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      throw Object.assign(new Error('Converted stock quantity must be greater than zero.'), { statusCode: 400 });
    }
    configuredUnitId = purchasePackage.unitId;
    unit = item.baseUnit || item.unit;
    conversionFactorOverride = 1;
  }
  if (!Number.isFinite(numericQuantity) || numericQuantity < 0 || (numericQuantity === 0 && !isStockCount)) {
    throw Object.assign(new Error(isStockCount ? 'Counted stock cannot be negative.' : 'Quantity must be a positive number.'), { statusCode: 400 });
  }
  let enteredUnitRecord;
  if (configuredUnitId) {
    enteredUnitRecord = await Unit.findOne({ _id: configuredUnitId, hotelId }).session(session);
  } else {
    enteredUnitRecord = await Unit.findOne({
      hotelId,
      symbolKey: String(enteredUnit).trim().toLocaleLowerCase(),
      ...(conversionFactor === undefined ? { isActive: true } : {})
    }).session(session);
  }
  if (item.baseUnitId) {
    const baseUnitRecord = await Unit.findOne({ _id: item.baseUnitId, hotelId }).session(session);
    if (!enteredUnitRecord || !baseUnitRecord) {
      throw Object.assign(new Error('Stock movement unit is not registered for this hotel.'), { statusCode: 400 });
    }
    if (!configuredUnitId && enteredUnitRecord.category !== baseUnitRecord.category) {
      throw Object.assign(new Error('Stock movement units must be compatible with the inventory item base unit.'), { statusCode: 400 });
    }
  }
  const converted = convertQuantityToBase(item, numericQuantity, unit || enteredUnit, conversionFactorOverride);
  let purchaseConversionFactor = converted.factor;
  const purchasePriceValue = purchaseUnitPrice === null || purchaseUnitPrice === undefined
    ? batchDetails.purchaseUnitCost
    : purchaseUnitPrice;
  const purchasePrice = purchasePriceValue === null || purchasePriceValue === undefined
    ? null
    : Number(purchasePriceValue);
  if (purchasePrice !== null && (!Number.isFinite(purchasePrice) || purchasePrice < 0)) {
    throw Object.assign(new Error('Purchase price must be a non-negative number.'), { statusCode: 400 });
  }
  if (movementType === 'receipt' && item.inventoryType === 'raw_material') {
    if (purchasePrice === null) {
      throw Object.assign(new Error('Purchase price is required before adding raw material stock.'), { statusCode: 400 });
    }
    if (!Number.isFinite(enteredQuantity) || enteredQuantity <= 0 || !String(enteredUnit || '').trim()) {
      throw Object.assign(new Error('Enter a positive purchased quantity and configured purchase unit.'), { statusCode: 400 });
    }
    const purchaseConfiguration = await resolveRawMaterialPurchaseUnit({
      item,
      hotelId,
      purchaseUnitId: configuredUnitId,
      purchaseUnit: unit || enteredUnit,
      purchasePackageId,
      conversionFactor: conversionFactor ?? (purchasePackage?.conversionFactorToBase || converted.factor),
      allowConversionSnapshot: purchasePackageSnapshot,
      session
    });
    if (batchDetails.purchaseQuantity !== undefined) {
      const recordedPurchaseQuantity = Number(batchDetails.purchaseQuantity);
      if (!Number.isFinite(recordedPurchaseQuantity) || recordedPurchaseQuantity <= 0
        || Math.abs(recordedPurchaseQuantity - enteredQuantity) > 1e-8) {
        throw Object.assign(new Error('Purchase quantity must match the quantity received.'), { statusCode: 400 });
      }
    }
    if (batchDetails.purchaseUnit
      && normalizeInventoryUnit(batchDetails.purchaseUnit) !== normalizeInventoryUnit(purchaseConfiguration.unit.symbol)) {
      throw Object.assign(new Error('Purchase unit must match the configured unit received.'), { statusCode: 400 });
    }
    purchaseConversionFactor = conversionFactor === undefined || conversionFactor === null
      ? purchaseConfiguration.conversionFactor
      : Number(conversionFactor);
    enteredUnit = purchaseConfiguration.entry.packageName
      || purchaseConfiguration.entry.unitSymbolSnapshot
      || purchaseConfiguration.unit.symbol;
  }
  const purchaseQuantityForFinancials = purchasePackage && hasPackageQuantity
    ? Number(packageQuantity) + (Number(looseQuantity) > 0 && Number(purchasePackage.conversionFactorToBase) > 0
      ? Number(looseQuantity) / Number(purchasePackage.conversionFactorToBase)
      : 0)
    : enteredQuantity;
  const purchaseSubtotal = purchasePrice !== null && Number.isFinite(purchaseQuantityForFinancials)
    ? roundMoney(purchaseQuantityForFinancials * purchasePrice)
    : 0;
  const resolvedDiscountPercent = Number(
    discountPercent ?? batchDetails.discountPercent ?? metadata.discountPercent ?? 0
  );
  let purchaseDiscountAmount = Number(
    purchaseDiscountAmountOverride
      ?? batchDetails.purchaseDiscountAmount
      ?? batchDetails.discountAmount
      ?? metadata.discountAmount
      ?? NaN
  );
  if (!Number.isFinite(purchaseDiscountAmount)) {
    purchaseDiscountAmount = Number.isFinite(resolvedDiscountPercent) && resolvedDiscountPercent > 0
      ? roundMoney(purchaseSubtotal * (resolvedDiscountPercent / 100))
      : 0;
  }
  if (!Number.isFinite(purchaseDiscountAmount) || purchaseDiscountAmount < 0
    || (purchaseDiscountAmount > 0 && (purchasePrice === null || movementType !== 'receipt'))) {
    throw Object.assign(new Error('Purchase discount must be a non-negative amount on a stock receipt with a purchase price.'), { statusCode: 400 });
  }
  if (purchaseDiscountAmount > purchaseSubtotal + 1e-8) {
    throw Object.assign(new Error('Purchase discount cannot exceed the purchase subtotal.'), { statusCode: 400 });
  }
  const taxableSubtotal = roundMoney(Math.max(0, purchaseSubtotal - purchaseDiscountAmount));
  const resolvedTaxPercent = Number(
    taxPercent ?? batchDetails.taxPercent ?? metadata.taxPercent ?? 0
  );
  let purchaseTaxAmount = Number(
    purchaseTaxAmountOverride
      ?? batchDetails.purchaseTaxAmount
      ?? batchDetails.taxAmount
      ?? metadata.taxAmount
      ?? NaN
  );
  if (!Number.isFinite(purchaseTaxAmount)) {
    purchaseTaxAmount = Number.isFinite(resolvedTaxPercent) && resolvedTaxPercent > 0
      ? roundMoney(taxableSubtotal * (resolvedTaxPercent / 100))
      : 0;
  }
  if (!Number.isFinite(purchaseTaxAmount) || purchaseTaxAmount < 0
    || (purchaseTaxAmount > 0 && (purchasePrice === null || movementType !== 'receipt'))) {
    throw Object.assign(new Error('Purchase tax must be a non-negative amount on a stock receipt with a purchase price.'), { statusCode: 400 });
  }
  const purchaseGrandTotal = roundMoney(taxableSubtotal + purchaseTaxAmount);
  if (autoGenerateBatchNumber && movementType === 'receipt' && !batchNumber) {
    const hotel = await Hotel.findById(hotelId).select('name').session(session);
    if (!hotel?.name) {
      throw Object.assign(new Error('Hotel name is required to generate a stock batch number.'), { statusCode: 400 });
    }
    const hotelCode = hotel.name.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'HTL';
    const itemCode = item.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item';
    const existingBatchNumbers = await InventoryBatch.find({ hotelId, propertyId, itemId: item._id })
      .select('batchNumber')
      .session(session)
      .lean();
    const latestSequence = existingBatchNumbers.reduce((latest, batch) => {
      const match = String(batch.batchNumber || '').match(/_B(\d+)$/i);
      return match ? Math.max(latest, Number(match[1])) : latest;
    }, 0);
    let nextSequence = latestSequence + 1;
    const existingNumbers = new Set(existingBatchNumbers.map((batch) => batch.batchNumber));
    batchNumber = `${hotelCode}_${itemCode}_B${nextSequence}`;
    while (existingNumbers.has(batchNumber)) {
      nextSequence += 1;
      batchNumber = `${hotelCode}_${itemCode}_B${nextSequence}`;
    }
  }
  const enteredUnitId = enteredUnitRecord?._id || configuredUnitId || null;
  const baseQuantity = roundQuantity(converted.quantity);
  const locationBalance = isStockCount
    ? await InventoryBalance.findOne({
      hotelId,
      propertyId,
      itemId: item._id,
      $or: [{ locationId }, { locationId: null, location }]
    }).session(session)
    : null;
  const currentLocationStock = locationBalance?.quantity ?? (location === 'Main Store' ? item.currentStock : 0);
  const delta = ['receipt', 'return', 'opening'].includes(movementType) ? baseQuantity
    : movementType === 'adjustment' || movementType === 'physical_count'
      ? baseQuantity - currentLocationStock
      : -baseQuantity;
  const receiptUnitCost = purchasePrice !== null
    ? (purchasePrice / converted.factor)
      - (baseQuantity > 0 ? purchaseDiscountAmount / baseQuantity : 0)
      + (baseQuantity > 0 ? purchaseTaxAmount / baseQuantity : 0)
    : Number.isFinite(Number(unitCostOverride)) ? Number(unitCostOverride) : item.unitCost;
  const purchaseQuantityForBatch = purchasePackage && hasPackageQuantity
    ? roundQuantity(enteredQuantity + recordedLooseQuantity / purchaseConversionFactor)
    : enteredQuantity;
  const purchaseFinancials = purchasePrice !== null && movementType === 'receipt'
    ? {
      quantity: purchaseQuantityForBatch,
      unitCost: purchasePrice,
      subtotal: purchaseSubtotal,
      discountAmount: roundMoney(purchaseDiscountAmount),
      discountPercent: Number.isFinite(resolvedDiscountPercent) ? resolvedDiscountPercent : 0,
      taxAmount: roundMoney(purchaseTaxAmount),
      taxPercent: Number.isFinite(resolvedTaxPercent) ? resolvedTaxPercent : 0,
      grandTotal: purchaseGrandTotal
    }
    : null;
  if (delta > 0 && item.trackExpiry && !expiryDate) {
    throw Object.assign(new Error(`An expiry date is required for ${item.name}.`), { statusCode: 400 });
  }
  if (delta > 0 && item.trackBatchNumber && !batchNumber) {
    throw Object.assign(new Error(`A batch number is required for ${item.name}.`), { statusCode: 400 });
  }

  let batchesToDeduct = [];
  let batchAllocations = [];
  const hasExpiryBatches = delta < 0 && await InventoryBatch.exists({
    hotelId,
    propertyId,
    itemId: item._id,
    $and: [
      { $or: [{ locationId }, { locationId: null, location }] },
      { expiryDate: { $ne: null } }
    ]
  }).session(session);
  if (delta < 0) {
    const now = new Date();
    const batchFilter = {
      hotelId,
      propertyId,
      itemId: item._id,
      $or: [{ locationId }, { locationId: null, location }],
      remainingQuantity: { $gt: 0 },
      ...(Array.isArray(batchIds) ? { _id: { $in: batchIds } } : {}),
      $and: [movementType === 'expiry'
        ? { expiryDate: { $lte: now } }
        : { $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }] }]
    };
    batchesToDeduct = await InventoryBatch.find(batchFilter)
      .sort({ receivedAt: 1, _id: 1 })
      .session(session);
    if (item.trackExpiry || hasExpiryBatches || movementType === 'expiry') {
      batchesToDeduct.sort((left, right) => {
        const leftExpiry = left.expiryDate ? new Date(left.expiryDate).getTime() : Number.POSITIVE_INFINITY;
        const rightExpiry = right.expiryDate ? new Date(right.expiryDate).getTime() : Number.POSITIVE_INFINITY;
        return leftExpiry - rightExpiry
          || new Date(left.receivedAt).getTime() - new Date(right.receivedAt).getTime()
          || String(left._id).localeCompare(String(right._id));
      });
    }
    const usableQuantity = batchesToDeduct.reduce((sum, batch) => sum + batch.remainingQuantity, 0);
    if ((item.trackExpiry || item.trackBatchNumber || hasExpiryBatches || movementType === 'expiry')
      && usableQuantity < Math.abs(delta)) {
      throw Object.assign(new Error(
        movementType === 'expiry'
          ? `Expired batch stock for ${item.name} is less than the adjustment quantity.`
          : `Insufficient unexpired batch stock for ${item.name} at ${location}.`
      ), { statusCode: 409 });
    }
  }
  const previousStock = item.currentStock;
  const nextStock = roundQuantity(previousStock + delta);
  if (nextStock < 0) {
    throw Object.assign(new Error(`Insufficient stock. Current stock is ${previousStock} ${item.unit}.`), { statusCode: 409 });
  }

  if (delta !== 0) {
    const itemUpdate = await InventoryItem.updateOne({
      _id: item._id,
      hotelId,
      propertyId,
      currentStock: delta < 0 ? { $gte: Math.abs(delta) } : previousStock
    }, { $inc: { currentStock: delta } }, { session });
    if (itemUpdate.modifiedCount !== 1) {
      throw Object.assign(new Error('Stock changed concurrently. Refresh and retry.'), { statusCode: 409 });
    }
  }

  const balanceMovement = await updateBalance({
    hotelId, propertyId, item, location, locationId, delta, session
  });
  let remainingToDeduct = Math.abs(delta);
  let movementTotalValue = 0;
  for (const batch of batchesToDeduct) {
    if (remainingToDeduct <= 0) break;
    const deduction = Math.min(batch.remainingQuantity, remainingToDeduct);
    const updatedBatch = await InventoryBatch.updateOne({
      _id: batch._id,
      remainingQuantity: { $gte: deduction }
    }, { $inc: { remainingQuantity: -deduction } }, { session });
    if (updatedBatch.modifiedCount !== 1) {
      throw Object.assign(new Error('Inventory batch changed concurrently; retry the stock operation.'), { statusCode: 409 });
    }
    const allocationCost = round(deduction * batch.unitCost);
    batchAllocations.push({
      batchId: batch._id,
      quantity: deduction,
      unitCost: batch.unitCost,
      totalCost: allocationCost,
      source: 'batch'
    });
    movementTotalValue += allocationCost;
    remainingToDeduct = roundQuantity(remainingToDeduct - deduction);
  }
  if (remainingToDeduct > 0) {
    const legacyCost = round(remainingToDeduct * item.unitCost);
    batchAllocations.push({
      batchId: null,
      quantity: remainingToDeduct,
      unitCost: item.unitCost,
      totalCost: legacyCost,
      source: 'legacy'
    });
    movementTotalValue += legacyCost;
  }
  if (delta > 0) {
    await InventoryBatch.create([{
      hotelId,
      propertyId,
      itemId: item._id,
      location,
      locationId,
      batchNumber,
      quantity: delta,
      remainingQuantity: delta,
      unitCost: receiptUnitCost,
      expiryDate,
      ...(vendorId ? { vendorId } : {}),
      ...batchDetails,
      ...(purchasePrice !== null ? {
        purchaseQuantity: purchaseQuantityForBatch,
        purchaseUnit: enteredUnit,
        purchaseUnitCost: purchasePrice,
        purchaseAmount: roundMoney(purchaseQuantityForBatch * purchasePrice),
        purchaseConversionFactor,
        purchaseDiscountAmount: roundMoney(purchaseDiscountAmount),
        purchaseTaxAmount: round(purchaseTaxAmount),
        purchaseTaxInclusiveUnitCost: receiptUnitCost * converted.factor,
        purchaseGrandTotal
      } : {}),
      ...(receivedAt ? { receivedAt } : {})
    }], { session });
  }
  if (delta >= 0) {
    movementTotalValue = purchaseFinancials
      ? purchaseGrandTotal
      : round(Math.abs(delta) * receiptUnitCost);
  } else movementTotalValue = round(movementTotalValue);
  const movementUnitCost = Math.abs(delta) > 0
    ? round(movementTotalValue / Math.abs(delta))
    : receiptUnitCost;
  const movement = await StockMovement.create([{
    hotelId,
    propertyId,
    itemId: item._id,
    movementType,
    transactionDate: transactionDate || new Date(),
    quantity: roundQuantity(Math.abs(delta)),
    previousStock,
    newStock: nextStock,
    unitCost: movementUnitCost,
    totalValue: movementTotalValue,
    referenceNumber,
    notes,
    recordedBy,
    location,
    locationId,
    department,
    vendorId,
    purchaseUnitPrice: purchasePrice,
    idempotencyKey,
    orderId,
    batchNumber,
    expiryDate,
    batchAllocations,
    enteredQuantity,
    enteredUnit: purchasePackage || purchasePackageName ? enteredUnit : converted.unit,
    enteredUnitId,
    purchasePackageId: purchasePackage?._id || purchasePackageId || null,
    purchasePackageName: purchasePackage?.packageName || purchasePackageName || '',
    looseQuantity: recordedLooseQuantity,
    conversionFactor: purchasePackage ? Number(purchasePackage.conversionFactorToBase) : converted.factor,
    baseUnit: item.baseUnit || item.unit,
    baseUnitId: item.baseUnitId || null,
    metadata: {
      ...metadata,
      ...(purchaseFinancials ? { purchaseFinancials } : {}),
      locationPreviousStock: balanceMovement.previous,
      locationNewStock: balanceMovement.current
    }
  }], { session }).then(([created]) => created);

  if (item.inventoryType === 'raw_material') {
    await evaluateAutomaticReorder({
      hotelId,
      propertyId,
      itemId: item._id,
      recordedBy,
      session
    });
  }

  return { movement, item: { ...item.toObject(), currentStock: nextStock }, duplicate: false };
};

export const runInventoryTransaction = async (operation) => {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

export const transferStock = async ({
  hotelId, propertyId, itemId, quantity, unit, conversionFactor, fromLocation, toLocation,
  fromLocationId, toLocationId, department = '',
  transferMode = 'location', fromDepartment = '', toDepartment = '',
  recordedBy, referenceNumber, idempotencyKey, notes = '', session
}) => {
  let sourceLocation = fromLocation;
  let destinationLocation = toLocation;
  let sourceDepartment = '';
  let destinationDepartment = '';
  if (transferMode === 'department') {
    sourceDepartment = String(fromDepartment || '').trim();
    destinationDepartment = String(toDepartment || '').trim();
    sourceLocation = DEPARTMENT_STOCK_LOCATIONS[sourceDepartment];
    destinationLocation = DEPARTMENT_STOCK_LOCATIONS[destinationDepartment];
    if (!sourceLocation || !destinationLocation) {
      throw Object.assign(new Error('Choose a valid source and destination department.'), { statusCode: 400 });
    }
    if (sourceDepartment === destinationDepartment) {
      throw Object.assign(new Error('Choose two different departments for the transfer.'), { statusCode: 400 });
    }
  } else if (transferMode !== 'location') {
    throw Object.assign(new Error('Transfer type must be location or department.'), { statusCode: 400 });
  }
  const enteredQuantity = Number(quantity);
  if (!Number.isFinite(enteredQuantity) || enteredQuantity <= 0
    || (!sourceLocation && !fromLocationId) || (!destinationLocation && !toLocationId)) {
    throw Object.assign(new Error('Transfer requires a positive quantity and two different stock locations.'), { statusCode: 400 });
  }
  const [sourceStorageLocation, destinationStorageLocation] = await Promise.all([
    resolveStorageLocation({
      hotelId,
      locationId: fromLocationId,
      locationName: sourceLocation,
      session
    }),
    resolveStorageLocation({
      hotelId,
      locationId: toLocationId,
      locationName: destinationLocation,
      session
    })
  ]);
  if (String(sourceStorageLocation._id) === String(destinationStorageLocation._id)) {
    throw Object.assign(new Error('Choose a destination different from the source storage location.'), { statusCode: 400 });
  }
  sourceLocation = sourceStorageLocation.locationName;
  destinationLocation = destinationStorageLocation.locationName;
  fromLocationId = sourceStorageLocation._id;
  toLocationId = destinationStorageLocation._id;
  const existing = idempotencyKey
    ? await StockMovement.findOne({ hotelId, propertyId, idempotencyKey: `${idempotencyKey}:out` }).session(session)
    : null;
  if (existing) return { movement: existing, duplicate: true };

  const item = await InventoryItem.findOne({ _id: itemId, hotelId, propertyId, isActive: true }).session(session);
  if (!item) throw Object.assign(new Error('Active inventory item not found.'), { statusCode: 404 });
  const converted = convertQuantityToBase(item, enteredQuantity, unit || item.baseUnit || item.unit, conversionFactor);
  const qty = roundQuantity(converted.quantity);
  const allSourceBatches = await InventoryBatch.find({
    hotelId,
    propertyId,
    itemId: item._id,
    $or: [{ locationId: fromLocationId }, { locationId: null, location: sourceLocation }],
    remainingQuantity: { $gt: 0 }
  }).sort({ receivedAt: 1, _id: 1 }).session(session);
  const now = new Date();
  const hasExpiryBatches = allSourceBatches.some((batch) => Boolean(batch.expiryDate));
  const sourceBatches = item.trackExpiry || hasExpiryBatches
    ? allSourceBatches.filter((batch) => !batch.expiryDate || batch.expiryDate > now)
    : allSourceBatches;
  const sourceBatchQuantity = sourceBatches.reduce((sum, batch) => sum + batch.remainingQuantity, 0);
  if ((item.trackExpiry || item.trackBatchNumber || hasExpiryBatches) && sourceBatchQuantity < qty) {
    throw Object.assign(new Error(`Insufficient tracked stock at ${sourceLocation} for ${item.name}.`), { statusCode: 409 });
  }
  const source = await updateBalance({
    hotelId, propertyId, item, location: sourceLocation, locationId: fromLocationId, delta: -qty, session
  });
  const destination = await updateBalance({
    hotelId, propertyId, item, location: destinationLocation, locationId: toLocationId, delta: qty, session
  });
  let batchQuantityToMove = Math.min(qty, sourceBatchQuantity);
  for (const batch of sourceBatches) {
    if (batchQuantityToMove <= 0) break;
    const movedQuantity = Math.min(batch.remainingQuantity, batchQuantityToMove);
    const update = await InventoryBatch.updateOne({
      _id: batch._id,
      remainingQuantity: { $gte: movedQuantity }
    }, { $inc: { remainingQuantity: -movedQuantity } }, { session });
    if (update.modifiedCount !== 1) {
      throw Object.assign(new Error('Inventory batch changed concurrently; retry the stock transfer.'), { statusCode: 409 });
    }
    await InventoryBatch.create([{
      hotelId,
      propertyId,
      itemId: item._id,
      location: destinationLocation,
      locationId: toLocationId,
      batchNumber: batch.batchNumber,
      quantity: movedQuantity,
      remainingQuantity: movedQuantity,
      unitCost: batch.unitCost,
      expiryDate: batch.expiryDate,
      receivedAt: batch.receivedAt
    }], { session });
    batchQuantityToMove = roundQuantity(batchQuantityToMove - movedQuantity);
  }
  const common = {
    hotelId, propertyId, itemId: item._id, movementType: 'transfer', quantity: qty,
    enteredQuantity, enteredUnit: converted.unit, conversionFactor: converted.factor,
    baseUnit: item.baseUnit || item.unit,
    previousStock: item.currentStock, newStock: item.currentStock,
    unitCost: item.unitCost, totalValue: round(qty * item.unitCost), referenceNumber,
    notes, recordedBy,
    sourceDepartment,
    destinationDepartment,
    department: transferMode === 'department' ? '' : department,
    destinationLocation,
    destinationLocationId: toLocationId,
    metadata: {
      fromLocation: sourceLocation,
      toLocation: destinationLocation,
      ...(transferMode === 'department' ? { sourceDepartment, destinationDepartment } : {})
    }
  };
  const movements = await StockMovement.create([
    {
      ...common,
      location: sourceLocation,
      locationId: fromLocationId,
      department: transferMode === 'department' ? sourceDepartment : department,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:out` : undefined,
      metadata: { ...common.metadata, locationPreviousStock: source.previous, locationNewStock: source.current }
    },
    {
      ...common,
      location: destinationLocation,
      locationId: toLocationId,
      department: transferMode === 'department' ? destinationDepartment : department,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:in` : undefined,
      metadata: { ...common.metadata, locationPreviousStock: destination.previous, locationNewStock: destination.current }
    }
  ], { session, ordered: true });
  return { movements, item, duplicate: false };
};

const isMovementCancelled = (movement) => (
  movement?.metadata?.status === 'cancelled'
  || Boolean(movement?.metadata?.reversedByMovementId)
  || Boolean(movement?.metadata?.cancelledAt)
);

const receiptBatchLocationFilter = (movement) => ([
  ...(movement.locationId ? [{ locationId: movement.locationId }] : []),
  { locationId: null, location: movement.location }
]);

const findReceiptBatch = async (movement, session) => {
  const locationFilter = {
    hotelId: movement.hotelId,
    propertyId: movement.propertyId,
    itemId: movement.itemId,
    $or: receiptBatchLocationFilter(movement)
  };
  if (movement.batchNumber) {
    const numbered = await InventoryBatch.findOne({
      ...locationFilter,
      batchNumber: movement.batchNumber
    }).sort({ receivedAt: -1, _id: -1 }).session(session);
    if (numbered) return numbered;
  }
  return InventoryBatch.findOne({
    ...locationFilter,
    remainingQuantity: { $gte: roundQuantity(Number(movement.quantity)) }
  }).sort({ receivedAt: -1, _id: -1 }).session(session);
};

export const cancelStockReceipt = async ({
  hotelId,
  propertyId,
  movementId,
  recordedBy,
  notes = '',
  idempotencyKey,
  session
}) => {
  const key = idempotencyKey || `cancel-receipt:${movementId}`;
  const existingReversal = await StockMovement.findOne({
    hotelId,
    propertyId,
    idempotencyKey: key
  }).session(session);
  if (existingReversal) {
    const original = await StockMovement.findOne({ _id: movementId, hotelId, propertyId }).session(session);
    return { movement: original, reversal: existingReversal, duplicate: true };
  }

  const movement = await StockMovement.findOne({
    _id: movementId,
    hotelId,
    propertyId
  }).session(session);
  if (!movement) throw Object.assign(new Error('Stock movement not found.'), { statusCode: 404 });
  if (movement.movementType !== 'receipt') {
    throw Object.assign(new Error('Only purchase receipts can be cancelled with this endpoint.'), { statusCode: 400 });
  }
  if (isMovementCancelled(movement)) {
    const prior = movement.metadata?.reversedByMovementId
      ? await StockMovement.findById(movement.metadata.reversedByMovementId).session(session)
      : null;
    return { movement, reversal: prior, duplicate: true };
  }

  const item = await InventoryItem.findOne({
    _id: movement.itemId, hotelId, propertyId
  }).session(session);
  if (!item) throw Object.assign(new Error('Inventory item not found.'), { statusCode: 404 });

  const qty = roundQuantity(Number(movement.quantity));
  const receiptBatch = await findReceiptBatch(movement, session);
  if (receiptBatch && roundQuantity(receiptBatch.remainingQuantity) + 1e-8 < qty) {
    throw Object.assign(new Error(
      'This purchase cannot be cancelled because part of the received stock has already been used.'
    ), { statusCode: 409 });
  }

  const previousStock = item.currentStock;
  const nextStock = roundQuantity(previousStock - qty);
  if (nextStock < -1e-8) {
    throw Object.assign(new Error('Insufficient remaining stock to reverse this purchase.'), { statusCode: 409 });
  }
  const updatedItem = await InventoryItem.findOneAndUpdate({
    _id: item._id,
    hotelId,
    propertyId,
    currentStock: { $gte: qty }
  }, { $inc: { currentStock: -qty } }, { new: true, session });
  if (!updatedItem) {
    throw Object.assign(new Error('Insufficient remaining stock to reverse this purchase.'), { statusCode: 409 });
  }
  const balance = await updateBalance({
    hotelId,
    propertyId,
    item: updatedItem,
    location: movement.location,
    locationId: movement.locationId,
    delta: -qty,
    session
  });
  if (receiptBatch) {
    const batchUpdate = await InventoryBatch.updateOne({
      _id: receiptBatch._id,
      remainingQuantity: { $gte: qty }
    }, { $inc: { remainingQuantity: -qty } }, { session });
    if (batchUpdate.modifiedCount !== 1) {
      throw Object.assign(new Error('Receipt batch changed concurrently; retry the purchase cancellation.'), { statusCode: 409 });
    }
  }

  const [reversal] = await StockMovement.create([{
    hotelId,
    propertyId,
    itemId: item._id,
    movementType: 'issue',
    quantity: qty,
    previousStock,
    newStock: nextStock,
    unitCost: movement.unitCost,
    totalValue: movement.totalValue,
    referenceNumber: movement.referenceNumber,
    notes: notes || `Purchase receipt cancelled: ${movement.referenceNumber || movement._id}`,
    recordedBy,
    location: movement.location,
    locationId: movement.locationId,
    department: movement.department || '',
    vendorId: movement.vendorId,
    purchaseUnitPrice: movement.purchaseUnitPrice,
    idempotencyKey: key,
    batchNumber: movement.batchNumber || '',
    enteredQuantity: movement.enteredQuantity,
    enteredUnit: movement.enteredUnit,
    enteredUnitId: movement.enteredUnitId,
    conversionFactor: movement.conversionFactor,
    baseUnit: movement.baseUnit,
    baseUnitId: movement.baseUnitId,
    batchAllocations: receiptBatch ? [{
      batchId: receiptBatch._id,
      quantity: qty,
      unitCost: movement.unitCost,
      totalCost: movement.totalValue,
      source: 'batch'
    }] : [],
    metadata: {
      source: 'purchase_cancellation',
      reversesMovementId: movement._id,
      locationPreviousStock: balance.previous,
      locationNewStock: balance.current,
      purchaseFinancials: movement.metadata?.purchaseFinancials || null
    }
  }], { session });

  movement.metadata = {
    ...(movement.metadata || {}),
    status: 'cancelled',
    cancelledAt: new Date(),
    reversedByMovementId: reversal._id
  };
  movement.markModified('metadata');
  await movement.save({ session });

  if (item.inventoryType === 'raw_material') {
    await evaluateAutomaticReorder({
      hotelId,
      propertyId,
      itemId: item._id,
      recordedBy,
      session
    });
  }

  return { movement, reversal, item: updatedItem, duplicate: false };
};

export const correctStockReceipt = async ({
  hotelId,
  propertyId,
  movementId,
  recordedBy,
  corrections = {},
  notes = '',
  idempotencyKey,
  session
}) => {
  const cancelKey = idempotencyKey ? `${idempotencyKey}:cancel` : `correct-receipt:${movementId}:cancel`;
  const postKey = idempotencyKey ? `${idempotencyKey}:repost` : `correct-receipt:${movementId}:repost`;
  const existingRepost = await StockMovement.findOne({ hotelId, propertyId, idempotencyKey: postKey }).session(session);
  if (existingRepost) {
    const original = await StockMovement.findOne({ _id: movementId, hotelId, propertyId }).session(session);
    const reversal = original?.metadata?.reversedByMovementId
      ? await StockMovement.findById(original.metadata.reversedByMovementId).session(session)
      : null;
    return { original, reversal, movement: existingRepost, duplicate: true };
  }

  const originalMovement = await StockMovement.findOne({ _id: movementId, hotelId, propertyId }).session(session);
  if (!originalMovement) throw Object.assign(new Error('Stock movement not found.'), { statusCode: 404 });
  if (originalMovement.movementType !== 'receipt') {
    throw Object.assign(new Error('Only purchase receipts can be corrected.'), { statusCode: 400 });
  }
  if (isMovementCancelled(originalMovement)) {
    const cancelledByThisCorrection = await StockMovement.exists({
      hotelId,
      propertyId,
      idempotencyKey: cancelKey
    }).session(session);
    if (!cancelledByThisCorrection) {
      throw Object.assign(new Error('This purchase was already cancelled and cannot be corrected.'), { statusCode: 409 });
    }
  }

  const cancelled = await cancelStockReceipt({
    hotelId,
    propertyId,
    movementId,
    recordedBy,
    notes: notes || 'Purchase corrected; original receipt reversed.',
    idempotencyKey: cancelKey,
    session
  });
  if (cancelled.duplicate && !cancelled.reversal) {
    throw Object.assign(new Error('This purchase was already cancelled and cannot be corrected.'), { statusCode: 409 });
  }

  const original = cancelled.movement;
  const quantity = corrections.quantity ?? original.enteredQuantity ?? original.quantity;
  const unit = corrections.unit ?? original.enteredUnit ?? original.baseUnit;
  const purchaseUnitPrice = corrections.purchaseUnitPrice
    ?? corrections.unitCost
    ?? original.purchaseUnitPrice
    ?? original.metadata?.purchaseFinancials?.unitCost;
  const purchaseTaxAmount = corrections.purchaseTaxAmount
    ?? corrections.taxAmount
    ?? original.metadata?.purchaseFinancials?.taxAmount
    ?? 0;
  const purchaseDiscountAmount = corrections.purchaseDiscountAmount
    ?? corrections.discountAmount
    ?? original.metadata?.purchaseFinancials?.discountAmount
    ?? 0;
  const taxPercent = corrections.taxPercent ?? original.metadata?.purchaseFinancials?.taxPercent ?? 0;
  const discountPercent = corrections.discountPercent
    ?? original.metadata?.purchaseFinancials?.discountPercent
    ?? 0;
  const purchasePackageId = corrections.purchasePackageId ?? original.purchasePackageId;
  const packageQuantity = corrections.packageQuantity
    ?? (purchasePackageId ? original.enteredQuantity : undefined);

  const repost = await postStockMovement({
    hotelId,
    propertyId,
    itemId: original.itemId,
    movementType: 'receipt',
    quantity,
    unit,
    unitId: corrections.unitId ?? original.enteredUnitId,
    conversionFactor: corrections.conversionFactor ?? original.conversionFactor,
    purchasePackageId,
    purchasePackageName: corrections.purchasePackageName ?? original.purchasePackageName,
    packageQuantity,
    looseQuantity: corrections.looseQuantity ?? original.looseQuantity ?? 0,
    purchaseUnitPrice,
    purchaseTaxAmount,
    purchaseDiscountAmount,
    taxPercent,
    discountPercent,
    vendorId: corrections.vendorId ?? original.vendorId,
    location: corrections.location ?? original.location,
    locationId: corrections.locationId ?? original.locationId,
    department: corrections.department ?? original.department ?? '',
    referenceNumber: original.referenceNumber,
    notes: notes || `Corrected purchase for ${original.referenceNumber || original._id}`,
    recordedBy,
    batchNumber: corrections.batchNumber || '',
    expiryDate: corrections.expiryDate ? new Date(corrections.expiryDate) : original.expiryDate,
    idempotencyKey: postKey,
    metadata: {
      source: 'purchase_correction',
      correctsMovementId: original._id,
      reversalMovementId: cancelled.reversal?._id
    },
    session
  });

  return {
    original,
    reversal: cancelled.reversal,
    movement: repost.movement,
    item: repost.item,
    duplicate: Boolean(repost.duplicate)
  };
};

export const cancelTransfer = async ({
  hotelId,
  propertyId,
  transferId,
  recordedBy,
  notes = '',
  idempotencyKey,
  session
}) => {
  const keyBase = idempotencyKey || `cancel-transfer:${transferId}`;
  const existingOut = await StockMovement.findOne({
    hotelId,
    propertyId,
    idempotencyKey: `${keyBase}:out`
  }).session(session);
  if (existingOut) {
    const pair = await StockMovement.find({
      hotelId,
      propertyId,
      referenceNumber: existingOut.referenceNumber,
      movementType: 'transfer',
      'metadata.source': 'transfer_cancellation'
    }).session(session);
    return { movements: pair.length ? pair : [existingOut], duplicate: true };
  }

  let seed = null;
  if (mongoose.isValidObjectId(transferId)) {
    seed = await StockMovement.findOne({
      _id: transferId,
      hotelId,
      propertyId,
      movementType: 'transfer'
    }).session(session);
  }
  if (!seed) {
    seed = await StockMovement.findOne({
      hotelId,
      propertyId,
      movementType: 'transfer',
      referenceNumber: String(transferId)
    }).session(session);
  }
  if (!seed) throw Object.assign(new Error('Stock transfer not found.'), { statusCode: 404 });
  if (seed.metadata?.source === 'transfer_cancellation') {
    throw Object.assign(new Error('Cannot cancel a transfer reversal movement.'), { statusCode: 400 });
  }

  const originals = await StockMovement.find({
    hotelId,
    propertyId,
    movementType: 'transfer',
    referenceNumber: seed.referenceNumber,
    $or: [
      { 'metadata.source': { $exists: false } },
      { 'metadata.source': { $ne: 'transfer_cancellation' } }
    ]
  }).sort({ createdAt: 1, _id: 1 }).session(session);

  if (originals.length < 2) {
    throw Object.assign(new Error('Transfer pair is incomplete and cannot be cancelled safely.'), { statusCode: 409 });
  }
  if (originals.some(isMovementCancelled)) {
    return { movements: originals, duplicate: true };
  }

  const fromLocation = originals[0].metadata?.fromLocation || originals[0].location;
  const toLocation = originals[0].metadata?.toLocation
    || originals[0].destinationLocation
    || originals[1].location;
  const outMovement = originals.find((movement) => movement.location === fromLocation) || originals[0];
  const inMovement = originals.find((movement) => movement.location === toLocation)
    || originals.find((movement) => String(movement._id) !== String(outMovement._id));
  if (!inMovement) {
    throw Object.assign(new Error('Transfer destination movement was not found.'), { statusCode: 409 });
  }

  const qty = roundQuantity(Number(outMovement.quantity));
  const item = await InventoryItem.findOne({
    _id: outMovement.itemId, hotelId, propertyId
  }).session(session);
  if (!item) throw Object.assign(new Error('Inventory item not found.'), { statusCode: 404 });

  const source = await updateBalance({
    hotelId,
    propertyId,
    item,
    location: fromLocation,
    locationId: outMovement.locationId,
    delta: qty,
    session
  });
  const destination = await updateBalance({
    hotelId,
    propertyId,
    item,
    location: toLocation,
    locationId: inMovement.locationId,
    delta: -qty,
    session
  });

  const destinationBatches = await InventoryBatch.find({
    hotelId,
    propertyId,
    itemId: item._id,
    $or: [
      ...(inMovement.locationId ? [{ locationId: inMovement.locationId }] : []),
      { locationId: null, location: toLocation }
    ],
    remainingQuantity: { $gt: 0 }
  }).sort({ receivedAt: 1, _id: 1 }).session(session);

  // Balance-only transfers (no destination batches) reverse location quantities only.
  // When batches exist, require enough remaining destination batch qty to reverse.
  const destinationBatchQty = destinationBatches.reduce(
    (sum, batch) => sum + Number(batch.remainingQuantity || 0),
    0
  );
  if (destinationBatches.length > 0 && destinationBatchQty + 1e-8 < qty) {
    throw Object.assign(new Error(
      'This transfer cannot be cancelled because destination stock is no longer available to reverse.'
    ), { statusCode: 409 });
  }

  let remainingToMove = destinationBatches.length ? qty : 0;
  for (const batch of destinationBatches) {
    if (remainingToMove <= 0) break;
    const movedQuantity = Math.min(batch.remainingQuantity, remainingToMove);
    const update = await InventoryBatch.updateOne({
      _id: batch._id,
      remainingQuantity: { $gte: movedQuantity }
    }, { $inc: { remainingQuantity: -movedQuantity } }, { session });
    if (update.modifiedCount !== 1) {
      throw Object.assign(new Error('Inventory batch changed concurrently; retry the transfer cancellation.'), { statusCode: 409 });
    }
    await InventoryBatch.create([{
      hotelId,
      propertyId,
      itemId: item._id,
      location: fromLocation,
      locationId: outMovement.locationId,
      batchNumber: batch.batchNumber,
      quantity: movedQuantity,
      remainingQuantity: movedQuantity,
      unitCost: batch.unitCost,
      expiryDate: batch.expiryDate,
      receivedAt: batch.receivedAt
    }], { session });
    remainingToMove = roundQuantity(remainingToMove - movedQuantity);
  }
  if (remainingToMove > 1e-8) {
    throw Object.assign(new Error(
      'This transfer cannot be cancelled because destination stock is no longer available to reverse.'
    ), { statusCode: 409 });
  }

  const reverseReference = generateReference('TRX');
  const common = {
    hotelId,
    propertyId,
    itemId: item._id,
    movementType: 'transfer',
    quantity: qty,
    enteredQuantity: outMovement.enteredQuantity,
    enteredUnit: outMovement.enteredUnit,
    conversionFactor: outMovement.conversionFactor,
    baseUnit: outMovement.baseUnit || item.baseUnit || item.unit,
    previousStock: item.currentStock,
    newStock: item.currentStock,
    unitCost: item.unitCost,
    totalValue: round(qty * item.unitCost),
    referenceNumber: reverseReference,
    notes: notes || `Cancelled transfer ${outMovement.referenceNumber}`,
    recordedBy,
    sourceDepartment: outMovement.destinationDepartment || '',
    destinationDepartment: outMovement.sourceDepartment || '',
    destinationLocation: fromLocation,
    destinationLocationId: outMovement.locationId,
    metadata: {
      source: 'transfer_cancellation',
      cancelsReferenceNumber: outMovement.referenceNumber,
      cancelsMovementIds: originals.map((movement) => String(movement._id)),
      fromLocation: toLocation,
      toLocation: fromLocation
    }
  };
  const reversals = await StockMovement.create([
    {
      ...common,
      location: toLocation,
      locationId: inMovement.locationId,
      department: inMovement.department || '',
      idempotencyKey: `${keyBase}:out`,
      metadata: { ...common.metadata, locationPreviousStock: destination.previous, locationNewStock: destination.current }
    },
    {
      ...common,
      location: fromLocation,
      locationId: outMovement.locationId,
      department: outMovement.department || '',
      idempotencyKey: `${keyBase}:in`,
      metadata: { ...common.metadata, locationPreviousStock: source.previous, locationNewStock: source.current }
    }
  ], { session, ordered: true });

  for (const original of originals) {
    original.metadata = {
      ...(original.metadata || {}),
      status: 'cancelled',
      cancelledAt: new Date(),
      reversedByReferenceNumber: reverseReference,
      reversedByMovementIds: reversals.map((movement) => String(movement._id))
    };
    original.markModified('metadata');
    await original.save({ session });
  }

  return { movements: reversals, originals, item, duplicate: false };
};

export const consumeRecipesForOrder = async (order, session, {
  skipEmpty = false,
  recordedBy = order.createdBy
} = {}) => {
  const existing = await RecipeConsumption.findOne({
    hotelId: order.hotelId, propertyId: order.propertyId, orderId: order._id
  }).session(session);
  if (existing) return existing;

  const menuItemIds = [...new Set(order.items.map((line) => String(line.menuItemId)))];
  const recipes = await InventoryRecipe.find({
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    menuItemId: { $in: menuItemIds },
    isActive: true
  }).sort({ version: -1 }).session(session);
  const latestRecipes = new Map();
  for (const recipe of recipes) {
    if (!latestRecipes.has(String(recipe.menuItemId))) latestRecipes.set(String(recipe.menuItemId), recipe);
  }
  const recipeLocations = new Map();
  for (const recipe of latestRecipes.values()) {
    if (recipe.productionMode === 'batch_production') continue;
    recipeLocations.set(String(recipe._id), await resolveStorageLocation({
      hotelId: order.hotelId,
      locationId: recipe.locationId,
      locationName: recipe.location || 'Restaurant Store',
      session
    }));
  }

  const required = new Map();
  for (const soldLine of order.items) {
    const recipe = latestRecipes.get(String(soldLine.menuItemId));
    if (!recipe || recipe.productionMode === 'batch_production') continue;
    for (const ingredient of recipe.ingredients) {
      if (ingredient.optional) continue;
      const requestedSubstitution = (soldLine.ingredientSubstitutions || []).find(
        (substitution) => String(substitution.ingredientItemId) === String(ingredient.itemId)
      );
      const selectedSubstitution = requestedSubstitution && ingredient.substitutions.find(
        (substitution) => String(substitution.itemId) === String(requestedSubstitution.substituteItemId)
      );
      if (requestedSubstitution && !selectedSubstitution) {
        throw Object.assign(new Error('The selected ingredient substitution is not allowed by the active recipe.'), { statusCode: 400 });
      }
      const consumedItemId = selectedSubstitution?.itemId || ingredient.itemId;
      const unit = selectedSubstitution?.unit || ingredient.unit;
      const enteredQuantity = (selectedSubstitution?.quantity ?? ingredient.quantity) * soldLine.quantity;
      const conversionFactor = selectedSubstitution?.conversionFactor ?? ingredient.conversionFactor;
      const itemId = String(consumedItemId);
      const item = await InventoryItem.findOne({
        _id: consumedItemId, hotelId: order.hotelId, propertyId: order.propertyId, isActive: true
      }).session(session);
      if (!item) throw Object.assign(new Error('A recipe ingredient is no longer an active inventory item.'), { statusCode: 409 });
      const converted = convertQuantityToBase(item, enteredQuantity, unit, conversionFactor || undefined);
      const quantity = roundQuantity(converted.quantity);
      const storageLocation = recipeLocations.get(String(recipe._id));
      const source = {
        menuItemId: soldLine.menuItemId,
        menuItemName: soldLine.name,
        version: recipe.version,
        quantity,
        unit: item.baseUnit || item.unit,
        enteredQuantity,
        enteredUnit: converted.unit,
        conversionFactor: converted.factor,
        locationId: storageLocation._id,
        location: storageLocation.locationName
      };
      const requirementKey = `${itemId}:${storageLocation._id}`;
      const prior = required.get(requirementKey);
      if (prior) {
        prior.quantity = roundQuantity(prior.quantity + quantity);
        prior.sources.push(source);
      } else {
        required.set(requirementKey, {
          item, quantity, menuItemId: soldLine.menuItemId, menuItemName: soldLine.name,
          version: recipe.version, unit: item.unit,
          locationId: storageLocation._id,
          location: storageLocation.locationName,
          sources: [source]
        });
      }
    }
  }

  if (!required.size && skipEmpty) return null;

  const entries = [];
  for (const requirement of required.values()) {
    const movementResult = await postStockMovement({
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      itemId: requirement.item._id,
      movementType: 'recipe_consumption',
      quantity: requirement.quantity,
      location: requirement.location,
      locationId: requirement.locationId,
      department: 'Restaurant',
      referenceNumber: order.orderNumber,
      notes: `Recipe consumption for finalized restaurant order ${order.orderNumber}`,
      recordedBy,
      orderId: order._id,
      idempotencyKey: `recipe-sale:${order._id}:${requirement.item._id}`,
      metadata: { recipeSources: requirement.sources },
      session
    });
    let remainingCost = movementResult.movement.totalValue;
    for (const [index, source] of requirement.sources.entries()) {
      const sourceCost = index === requirement.sources.length - 1
        ? round(remainingCost)
        : round(movementResult.movement.totalValue * (source.quantity / requirement.quantity));
      remainingCost = round(remainingCost - sourceCost);
      entries.push({
        itemId: requirement.item._id,
        menuItemId: source.menuItemId,
        menuItemName: source.menuItemName,
        recipeVersion: source.version,
        quantity: source.quantity,
        unit: source.unit,
        enteredQuantity: source.enteredQuantity,
        enteredUnit: source.enteredUnit,
        conversionFactor: source.conversionFactor,
        baseUnit: source.unit,
        unitCost: source.quantity > 0 ? round(sourceCost / source.quantity) : 0,
        totalCost: sourceCost
      });
    }
  }

  return RecipeConsumption.create([{
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    ingredients: entries,
    totalCost: round(entries.reduce((sum, entry) => sum + entry.totalCost, 0))
  }], { session }).then(([created]) => created);
};

export const reverseRecipeConsumptionForOrder = async (order, session, recordedBy) => {
  const consumption = await RecipeConsumption.findOne({
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    orderId: order._id
  }).session(session);
  if (!consumption || consumption.status === 'reversed') return consumption;

  const movements = await StockMovement.find({
    hotelId: order.hotelId,
    propertyId: order.propertyId,
    orderId: order._id,
    movementType: 'recipe_consumption'
  }).session(session);

  for (const movement of movements) {
    const item = await InventoryItem.findOneAndUpdate(
      { _id: movement.itemId, hotelId: order.hotelId, propertyId: order.propertyId },
      { $inc: { currentStock: movement.quantity } },
      { new: true, session }
    );
    if (!item) {
      throw Object.assign(new Error('A recipe ingredient could not be restored because its inventory item is missing.'), { statusCode: 409 });
    }

    const balance = await updateBalance({
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      item,
      location: movement.location,
      delta: movement.quantity,
      session
    });

    const restoredAllocations = [];
    for (const allocation of movement.batchAllocations || []) {
      if (!allocation.batchId) {
        restoredAllocations.push({
          batchId: null,
          quantity: allocation.quantity,
          unitCost: allocation.unitCost,
          totalCost: allocation.totalCost,
          source: allocation.source
        });
        continue;
      }
      const restoredBatch = await InventoryBatch.findOneAndUpdate({
        _id: allocation.batchId,
        hotelId: order.hotelId,
        propertyId: order.propertyId,
        itemId: movement.itemId,
        location: movement.location,
        $expr: {
          $lte: [
            { $add: ['$remainingQuantity', allocation.quantity] },
            '$quantity'
          ]
        }
      }, { $inc: { remainingQuantity: allocation.quantity } }, { new: true, session });
      if (!restoredBatch) {
        throw Object.assign(new Error('A consumed inventory batch could not be restored safely.'), { statusCode: 409 });
      }
      restoredAllocations.push({
        batchId: allocation.batchId,
        quantity: allocation.quantity,
        unitCost: allocation.unitCost,
        totalCost: allocation.totalCost,
        source: allocation.source
      });
    }

    const previousStock = roundQuantity(item.currentStock - movement.quantity);
    await StockMovement.create([{
      hotelId: order.hotelId,
      propertyId: order.propertyId,
      itemId: movement.itemId,
      movementType: 'sale_reversal',
      quantity: movement.quantity,
      previousStock,
      newStock: item.currentStock,
      unitCost: movement.unitCost,
      totalValue: movement.totalValue,
      referenceNumber: order.orderNumber,
      notes: `Recipe consumption reversal for cancelled restaurant order ${order.orderNumber}`,
      recordedBy,
      location: movement.location,
      department: movement.department,
      orderId: order._id,
      idempotencyKey: `recipe-sale-reversal:${order._id}:${movement.itemId}`,
      batchAllocations: restoredAllocations,
      metadata: {
        reversedMovementId: movement._id,
        locationPreviousStock: balance.previous,
        locationNewStock: balance.current
      }
    }], { session });
    if (item.inventoryType === 'raw_material') {
      await evaluateAutomaticReorder({
        hotelId: order.hotelId,
        propertyId: order.propertyId,
        itemId: movement.itemId,
        recordedBy,
        session
      });
    }
  }

  consumption.status = 'reversed';
  consumption.reversedAt = new Date();
  await consumption.save({ session });
  return consumption;
};
