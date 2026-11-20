import mongoose from 'mongoose';
import {
  DepartmentRequest, GoodsReceipt, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, InventorySettings,
  FoodOrder, Hotel, StockAdjustment, StockVerification, MinibarStock, MinibarTransaction, PurchaseOrder, RecipeConsumption,
  PreparedFoodMovement, ProductionBatch, StockMovement, Room, Reservation, Invoice, Vendor
} from '../models/index.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import {
  cancelTransfer, getInventoryBatchAverageCosts, postStockMovement, recordDirectInventoryUsage,
  runInventoryTransaction, transferStock
} from '../services/inventoryService.js';
import { resolveStorageLocation } from '../services/storageLocationService.js';
import { convertQuantityToBase, getUnitConversionFactor, normalizeInventoryUnit } from '../config/inventoryUnits.js';
import { combineHotelDateAndTime } from '../utils/reservationDates.js';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isValidDateOnly = (value) => {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const nextDateOnly = (dateOnly) => {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
};

const hotelLocalDateFilter = (from, to, timeZone) => {
  if (!from && !to) return undefined;
  if ((from && !isValidDateOnly(from)) || (to && !isValidDateOnly(to))) {
    throw Object.assign(new Error('Choose valid report dates.'), { statusCode: 400 });
  }
  if (from && to && from > to) {
    throw Object.assign(new Error('The start date must be on or before the end date.'), { statusCode: 400 });
  }

  const filter = {};
  if (from) {
    const start = combineHotelDateAndTime(from, '00:00', timeZone);
    if (!start) throw Object.assign(new Error('The start date is invalid for the hotel timezone.'), { statusCode: 400 });
    filter.$gte = start;
  }
  if (to) {
    const end = combineHotelDateAndTime(nextDateOnly(to), '00:00', timeZone);
    if (!end) throw Object.assign(new Error('The end date is invalid for the hotel timezone.'), { statusCode: 400 });
    filter.$lt = end;
  }
  return filter;
};

const adminOnly = (req, res) => {
  if (['hotel_admin', 'super_admin'].includes(req.user?.role)) return true;
  res.status(403).json({ success: false, message: 'Hotel administrator access is required.' });
  return false;
};

const tenantFilter = (req) => ({
  hotelId: req.hotelId,
  ...(req.propertyId ? { propertyId: req.propertyId } : {})
});

export const getDirectInventoryUsage = async (req, res, next) => {
  try {
    const filter = {
      ...tenantFilter(req),
      'metadata.source': { $in: ['manual_complimentary_usage', 'manual_unrecorded_usage'] }
    };
    const recentMovements = await StockMovement.find(filter)
      .select('metadata createdAt')
      .sort({ createdAt: -1 })
      .limit(Math.min(1000, Math.max(1, Number(req.query.limit) || 500)))
      .lean();
    const usageIds = [...new Set(recentMovements
      .map((movement) => movement.metadata?.directUsage?.usageId)
      .filter(Boolean))];
    const movements = usageIds.length
      ? await StockMovement.find({
        ...filter,
        'metadata.directUsage.usageId': { $in: usageIds }
      })
        .populate('itemId', 'name code unit baseUnit')
        .sort({ createdAt: -1 })
        .lean()
      : [];
    const groups = new Map();
    for (const movement of movements) {
      const usage = movement.metadata?.directUsage;
      if (!usage?.usageId) continue;
      const row = groups.get(usage.usageId) || {
        _id: usage.usageId,
        ...usage,
        movementType: usage.usageType,
        createdAt: movement.createdAt,
        location: movement.location || '',
        totalCost: 0,
        ingredients: []
      };
      row.totalCost += Number(movement.totalValue) || 0;
      row.createdAt = new Date(movement.createdAt) > new Date(row.createdAt)
        ? movement.createdAt
        : row.createdAt;
      row.ingredients.push({
        itemId: String(movement.itemId?._id || movement.itemId),
        itemName: movement.itemId?.name || 'Raw material',
        quantity: Number(movement.quantity) || 0,
        unit: movement.baseUnit || movement.itemId?.baseUnit || movement.itemId?.unit || '',
        cost: Number(movement.totalValue) || 0
      });
      groups.set(usage.usageId, row);
    }
    res.json({
      success: true,
      data: [...groups.values()].map((row) => ({
        ...row,
        totalCost: Math.round(row.totalCost * 100) / 100
      }))
    });
  } catch (error) {
    next(error);
  }
};

export const createDirectInventoryUsage = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const { targetType, targetId, usageType, quantity, reason, location } = req.body;
    const idempotencyKey = String(req.body.idempotencyKey || req.get('Idempotency-Key') || '');
    if (!idempotencyKey.trim()) {
      return res.status(400).json({ success: false, message: 'A usage request key is required to prevent duplicate stock updates.' });
    }
    const result = await runInventoryTransaction((session) => recordDirectInventoryUsage({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      targetType,
      targetId,
      usageType,
      quantity,
      reason,
      location,
      recordedBy: req.user._id,
      idempotencyKey
    }, session));
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: usageType === 'complimentary'
          ? 'RECORD_DIRECT_COMPLIMENTARY_USAGE'
          : 'RECORD_DIRECT_UNRECORDED_USAGE',
        entity: 'StockMovement',
        entityId: result.movements[0]?._id,
        details: {
          targetType,
          targetId,
          usageType,
          quantity,
          totalCost: result.totalCost,
          reason
        },
        req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const dateFilter = (query) => {
  const filter = {};
  if (query.from) {
    const from = new Date(query.from);
    if (Number.isNaN(from.getTime())) throw Object.assign(new Error('Invalid start date.'), { statusCode: 400 });
    filter.$gte = from;
  }
  if (query.to) {
    const to = new Date(query.to);
    if (Number.isNaN(to.getTime())) throw Object.assign(new Error('Invalid end date.'), { statusCode: 400 });
    to.setHours(23, 59, 59, 999);
    filter.$lte = to;
  }
  return Object.keys(filter).length ? filter : undefined;
};

export const getInventoryDashboard = async (req, res, next) => {
  try {
    const scope = tenantFilter(req);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const expiryEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const movementTrendStart = new Date(now);
    movementTrendStart.setDate(movementTrendStart.getDate() - 13);
    movementTrendStart.setHours(0, 0, 0, 0);
    const [items, expiredBatches, batchValues, pendingOrders, monthPurchases, recent, expiring, monthlyPurchases, departmentUse, monthlyCosts, unrecordedConsumption, preparedFoodUnrecordedMonth, movementTrend, preparedFoodUnrecordedTrend] = await Promise.all([
      InventoryItem.find({ ...scope, isActive: true })
        .select('name currentStock minStockThreshold unitCost unit baseUnit stockVerificationIntervalDays createdAt')
        .lean(),
      InventoryBatch.aggregate([
        { $match: { ...scope, expiryDate: { $lte: now }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ]),
      InventoryBatch.aggregate([
        { $match: { ...scope, remainingQuantity: { $gt: 0 } } },
        { $group: {
          _id: '$itemId',
          quantity: { $sum: '$remainingQuantity' },
          value: { $sum: { $multiply: ['$remainingQuantity', '$unitCost'] } }
        } }
      ]),
      PurchaseOrder.countDocuments({ ...scope, status: { $in: ['pending_approval', 'approved', 'ordered', 'partially_received'] } }),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: 'receipt' } },
        { $addFields: { effectiveDate: { $ifNull: ['$transactionDate', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: monthStart, $lt: nextMonth } } },
        { $group: { _id: null, total: { $sum: '$totalValue' }, count: { $sum: 1 } } }
      ]),
      StockMovement.find(scope).populate('itemId', 'name unit').populate('recordedBy', 'name')
        .sort({ createdAt: -1 }).limit(8).lean(),
      GoodsReceipt.aggregate([
        { $match: { ...scope, 'lines.expiryDate': { $gte: now, $lte: expiryEnd } } },
        { $unwind: '$lines' },
        { $match: { 'lines.expiryDate': { $gte: now, $lte: expiryEnd }, 'lines.acceptedQuantity': { $gt: 0 } } },
        { $lookup: { from: 'inventoryitems', localField: 'lines.itemId', foreignField: '_id', as: 'item' } },
        { $unwind: '$item' },
        { $project: { _id: 0, item: '$item.name', batchNumber: '$lines.batchNumber', expiryDate: '$lines.expiryDate', quantity: '$lines.acceptedQuantity' } },
        { $sort: { expiryDate: 1 } },
        { $limit: 10 }
      ]),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: 'receipt' } },
        { $addFields: { effectiveDate: { $ifNull: ['$transactionDate', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: new Date(now.getFullYear(), now.getMonth() - 5, 1) } } },
        { $group: { _id: { year: { $year: '$effectiveDate' }, month: { $month: '$effectiveDate' } }, total: { $sum: '$totalValue' } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: { $in: ['issue', 'department_issue', 'recipe_consumption', 'wastage', 'expiry'] } } },
        { $group: { _id: { $ifNull: ['$department', 'Unassigned'] }, quantity: { $sum: '$quantity' }, expense: { $sum: '$totalValue' } } },
        { $sort: { expense: -1 } }
      ]),
      StockMovement.aggregate([
        { $match: { ...scope, movementType: { $in: ['receipt', 'issue', 'department_issue', 'recipe_consumption', 'wastage', 'expiry'] } } },
        { $addFields: { effectiveDate: { $ifNull: ['$transactionDate', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: monthStart, $lt: nextMonth } } },
        { $group: { _id: '$movementType', total: { $sum: '$totalValue' } } }
      ]),
      StockMovement.aggregate([
        {
          $match: {
            ...scope,
            movementType: 'issue',
            'metadata.source': { $in: ['stock_verification_unrecorded_consumption', 'manual_unrecorded_usage'] }
          }
        },
        { $addFields: { effectiveDate: { $ifNull: ['$transactionDate', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: monthStart, $lt: nextMonth } } },
        { $group: { _id: null, total: { $sum: '$totalValue' }, quantity: { $sum: '$quantity' } } }
      ]),
      PreparedFoodMovement.aggregate([
        {
          $match: {
            ...scope,
            movementType: 'unrecorded_consumption',
            createdAt: { $gte: monthStart, $lt: nextMonth }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$totalCost' },
            quantity: { $sum: '$quantity' }
          }
        }
      ]),
      StockMovement.aggregate([
        {
          $match: {
            ...scope,
            movementType: { $in: ['receipt', 'issue', 'department_issue', 'recipe_consumption', 'wastage', 'expiry'] }
          }
        },
        { $addFields: { effectiveDate: { $ifNull: ['$transactionDate', '$createdAt'] } } },
        { $match: { effectiveDate: { $gte: movementTrendStart, $lte: now } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$effectiveDate' } },
            incoming: { $sum: { $cond: [{ $eq: ['$movementType', 'receipt'] }, '$totalValue', 0] } },
            wastage: { $sum: { $cond: [{ $in: ['$movementType', ['wastage', 'expiry']] }, '$totalValue', 0] } },
            unrecordedUsage: {
              $sum: {
                $cond: [
                  {
                    $in: [
                      '$metadata.source',
                      ['stock_verification_unrecorded_consumption', 'manual_unrecorded_usage']
                    ]
                  },
                  '$totalValue',
                  0
                ]
              }
            },
            recordedUsage: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ['$movementType', ['issue', 'department_issue', 'recipe_consumption']] },
                      {
                        $not: [{
                          $in: [
                            '$metadata.source',
                            ['stock_verification_unrecorded_consumption', 'manual_unrecorded_usage']
                          ]
                        }]
                      }
                    ]
                  },
                  '$totalValue',
                  0
                ]
              }
            }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      PreparedFoodMovement.aggregate([
        {
          $match: {
            ...scope,
            movementType: 'unrecorded_consumption',
            createdAt: { $gte: movementTrendStart, $lte: now }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            total: { $sum: '$totalCost' }
          }
        },
        { $sort: { _id: 1 } }
      ])
    ]);
    const preparedFoodUnrecordedByDate = new Map(
      preparedFoodUnrecordedTrend.map((entry) => [entry._id, Number(entry.total) || 0])
    );
    const movementTrendWithPreparedFoodLoss = movementTrend.map((entry) => ({
      ...entry,
      preparedFoodUnrecordedUsage: preparedFoodUnrecordedByDate.get(entry._id) || 0
    }));
    for (const [date, total] of preparedFoodUnrecordedByDate) {
      if (movementTrendWithPreparedFoodLoss.some((entry) => entry._id === date)) continue;
      movementTrendWithPreparedFoodLoss.push({
        _id: date,
        incoming: 0,
        wastage: 0,
        unrecordedUsage: 0,
        recordedUsage: 0,
        preparedFoodUnrecordedUsage: total
      });
    }
    movementTrendWithPreparedFoodLoss.sort((left, right) => left._id.localeCompare(right._id));
    const [settings, latestVerifications] = await Promise.all([
      InventorySettings.findOne(scope).lean(),
      StockVerification.aggregate([
        { $match: scope },
        { $sort: { verifiedAt: -1 } },
        { $group: { _id: '$itemId', verifiedAt: { $first: '$verifiedAt' } } }
      ])
    ]);

    const expiredByItem = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    const batchValueByItem = new Map(batchValues.map((batch) => [String(batch._id), batch]));
    const verifiedAtByItem = new Map(latestVerifications.map((entry) => [String(entry._id), entry.verifiedAt]));
    const monthlyCostByType = Object.fromEntries(monthlyCosts.map(({ _id, total }) => [_id, total]));
    const pendingVerifications = items.filter((item) => {
      const lastVerified = verifiedAtByItem.get(String(item._id)) || item.createdAt;
      const intervalDays = item.stockVerificationIntervalDays || settings?.verificationIntervalDays || 1;
      return !lastVerified || now.getTime() - new Date(lastVerified).getTime() >= intervalDays * 86400000;
    }).map((item) => ({
      _id: item._id,
      name: item.name,
      unit: item.baseUnit || item.unit,
      currentStock: item.currentStock,
      createdAt: item.createdAt,
      lastVerifiedAt: verifiedAtByItem.get(String(item._id)) || null
    }));
    const availableByItem = items.map((item) => ({
      ...item,
      available: Math.max(0, item.currentStock - (expiredByItem.get(String(item._id)) || 0))
    }));
    res.json({
      success: true,
      data: {
        totalItems: items.length,
        totalStockValue: items.reduce((sum, item) => {
          const batch = batchValueByItem.get(String(item._id));
          const unbatchedQuantity = Math.max(0, item.currentStock - (batch?.quantity || 0));
          return sum + (batch?.value || 0) + unbatchedQuantity * item.unitCost;
        }, 0),
        availableStock: availableByItem.reduce((sum, item) => sum + item.available, 0),
        lowStockItems: availableByItem.filter((item) => item.available > 0 && item.available <= item.minStockThreshold).length,
        outOfStockItems: availableByItem.filter((item) => item.available <= 0).length,
        pendingPurchaseOrders: pendingOrders,
        purchasesThisMonth: monthPurchases[0]?.total || 0,
        consumptionCostThisMonth: Math.max(0,
          ['issue', 'department_issue', 'recipe_consumption']
            .reduce((sum, type) => sum + (monthlyCostByType[type] || 0), 0)
            - (unrecordedConsumption[0]?.total || 0)),
        unrecordedConsumptionCostThisMonth: (unrecordedConsumption[0]?.total || 0)
          + (preparedFoodUnrecordedMonth[0]?.total || 0),
        unrecordedRawMaterialCostThisMonth: unrecordedConsumption[0]?.total || 0,
        unrecordedPreparedFoodCostThisMonth: preparedFoodUnrecordedMonth[0]?.total || 0,
        unrecordedConsumptionQuantityThisMonth: Math.abs(unrecordedConsumption[0]?.quantity || 0),
        unrecordedPreparedFoodQuantityThisMonth: preparedFoodUnrecordedMonth[0]?.quantity || 0,
        wastageCostThisMonth: (monthlyCostByType.wastage || 0) + (monthlyCostByType.expiry || 0),
        purchaseCountThisMonth: monthPurchases[0]?.count || 0,
        pendingStockVerifications: pendingVerifications.length,
        pendingVerificationItems: pendingVerifications,
        verificationIntervalDays: settings?.verificationIntervalDays || 1,
        monthlyPurchases,
        departmentConsumption: departmentUse,
        movementTrend: movementTrendWithPreparedFoodLoss,
        recentActivities: recent,
        expiringProducts: expiring
      }
    });
  } catch (err) {
    next(err);
  }
};

export const getInventorySettings = async (req, res, next) => {
  try {
    const settings = await InventorySettings.findOne(tenantFilter(req)).lean();
    res.json({
      success: true,
      data: settings || {
        verificationIntervalDays: 1,
        recipeDeductionStage: 'prepared',
        hotelId: req.hotelId,
        propertyId: req.propertyId
      }
    });
  } catch (err) {
    next(err);
  }
};

export const updateInventorySettings = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const updates = {};
    if (req.body.verificationIntervalDays !== undefined) {
      const verificationIntervalDays = Number(req.body.verificationIntervalDays);
      if (!Number.isInteger(verificationIntervalDays) || verificationIntervalDays < 1 || verificationIntervalDays > 365) {
        return res.status(400).json({ success: false, message: 'Verification interval must be a whole number from 1 to 365 days.' });
      }
      updates.verificationIntervalDays = verificationIntervalDays;
    }
    if (req.body.recipeDeductionStage !== undefined) {
      if (!['prepared', 'served'].includes(req.body.recipeDeductionStage)) {
        return res.status(400).json({ success: false, message: 'Recipe deduction stage must be prepared or served.' });
      }
      updates.recipeDeductionStage = req.body.recipeDeductionStage;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'Provide an inventory setting to update.' });
    }
    const settings = await InventorySettings.findOneAndUpdate(
      tenantFilter(req),
      { $set: { ...updates, updatedBy: req.user._id } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_INVENTORY_SETTINGS',
      entity: 'InventorySettings',
      entityId: settings._id,
      details: updates,
      req
    });
    res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
};

export const getStockVerifications = async (req, res, next) => {
  try {
    const data = await StockVerification.find(tenantFilter(req))
      .populate('itemId', 'name code unit baseUnit')
      .populate('verifiedBy', 'name')
      .sort({ verifiedAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createStockVerification = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const {
      itemId, actualStock, unit, periodStart, periodEnd, location = 'Main Store', locationId,
      consumptionQuantity = 0, consumptionUnit, consumptionReason = '', department = '',
      wastageQuantity = 0, wastageUnit, wastageReason = '',
      remarks = ''
    } = req.body;
    if (!mongoose.isValidObjectId(itemId) || !String(location).trim()) {
      return res.status(400).json({ success: false, message: 'Select a valid raw material and stock location.' });
    }
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return res.status(400).json({ success: false, message: 'Enter a valid verification period that does not end in the future.' });
    }
    const timezoneOffsetMinutes = Number(req.body.timezoneOffsetMinutes || 0);
    if (!Number.isInteger(timezoneOffsetMinutes) || Math.abs(timezoneOffsetMinutes) > 840) {
      return res.status(400).json({ success: false, message: 'Enter a valid local timezone offset.' });
    }
    const localToday = new Date(Date.now() - timezoneOffsetMinutes * 60000).toISOString().slice(0, 10);
    if (end.toISOString().slice(0, 10) !== localToday) {
      return res.status(400).json({ success: false, message: 'Period end must be today.' });
    }
    const numbers = [actualStock, consumptionQuantity, wastageQuantity].map(Number);
    if (numbers.some((value) => !Number.isFinite(value) || value < 0)) {
      return res.status(400).json({ success: false, message: 'Stock and reconciliation quantities must be non-negative numbers.' });
    }
    const consumptionDepartment = String(department || '').trim();
    if (numbers[1] > 0 && !consumptionDepartment) {
      return res.status(400).json({ success: false, message: 'Enter the department responsible for unrecorded consumption.' });
    }
    if (consumptionDepartment.length > 120) {
      return res.status(400).json({ success: false, message: 'Department name must be 120 characters or fewer.' });
    }
    const idempotencyKey = req.body.idempotencyKey || req.get('Idempotency-Key');
    const result = await runInventoryTransaction(async (session) => {
      if (idempotencyKey) {
        const duplicate = await StockVerification.findOne({
          ...tenantFilter(req), idempotencyKey
        }).session(session);
        if (duplicate) return { verification: duplicate, duplicate: true };
      }
      const item = await InventoryItem.findOne({
        _id: itemId, ...tenantFilter(req), isActive: true
      }).session(session);
      if (!item) throw Object.assign(new Error('Active inventory item not found.'), { statusCode: 404 });
      const storageLocation = await resolveStorageLocation({
        hotelId: req.hotelId, locationId, locationName: location, session
      });
      const selectedLocation = storageLocation.locationName;
      const previousVerification = await StockVerification.findOne({
        ...tenantFilter(req),
        itemId: item._id,
        $or: [{ locationId: storageLocation._id }, { locationId: null, location: selectedLocation }]
      }).sort({ verifiedAt: -1 }).session(session);
      const requiredPeriodStart = previousVerification?.periodEnd
        ? new Date(previousVerification.periodEnd).toISOString().slice(0, 10)
        : new Date(new Date(item.createdAt).getTime() - timezoneOffsetMinutes * 60000).toISOString().slice(0, 10);
      if (start.toISOString().slice(0, 10) !== requiredPeriodStart) {
        throw Object.assign(new Error('Period start must match the last physical verification date.'), { statusCode: 400 });
      }
      const selectedUnit = normalizeInventoryUnit(unit || item.baseUnit || item.unit);
      const convertedActual = convertQuantityToBase(item, numbers[0], selectedUnit);
      const convertedConsumption = convertQuantityToBase(
        item, numbers[1], normalizeInventoryUnit(consumptionUnit || selectedUnit)
      );
      const convertedWastage = convertQuantityToBase(
        item, numbers[2], normalizeInventoryUnit(wastageUnit || selectedUnit)
      );
      const balance = await InventoryBalance.findOne({
        ...tenantFilter(req), itemId: item._id,
        $or: [{ locationId: storageLocation._id }, { locationId: null, location: selectedLocation }]
      }).session(session);
      const expectedStock = balance?.quantity ?? (selectedLocation === 'Main Store' ? item.currentStock : 0);
      const delta = Math.round((convertedActual.quantity - expectedStock + Number.EPSILON) * 1e8) / 1e8;
      const reduction = Math.max(0, -delta);
      if (convertedConsumption.quantity + convertedWastage.quantity > reduction + 1e-8) {
        throw Object.assign(new Error('Consumption and wastage cannot exceed the difference between expected and actual stock.'), { statusCode: 400 });
      }
      const discrepancyQuantity = Math.max(
        0,
        Math.round((reduction - convertedConsumption.quantity - convertedWastage.quantity + Number.EPSILON) * 1e8) / 1e8
      );
      const stockGain = Math.max(0, delta);
      const discrepancyLabel = discrepancyQuantity > 0 ? 'Profitably consumed' : stockGain > 0 ? 'Stock gain' : '';
      const [verification] = await StockVerification.create([{
        ...tenantFilter(req),
        itemId: item._id,
        location: selectedLocation,
        locationId: storageLocation._id,
        periodStart: start,
        periodEnd: end,
        expectedStock,
        actualStock: convertedActual.quantity,
        consumptionQuantity: convertedConsumption.quantity,
        consumptionReason: String(consumptionReason).trim(),
        department: convertedConsumption.quantity > 0 ? consumptionDepartment : '',
        wastageQuantity: convertedWastage.quantity,
        wastageReason: String(wastageReason).trim(),
        discrepancyQuantity,
        stockGain,
        unit: item.baseUnit || item.unit,
        remarks: String(remarks).trim(),
        status: 'approved',
        verifiedBy: req.user._id,
        idempotencyKey: idempotencyKey || undefined
      }], { session });
      const movements = [];
      if (convertedConsumption.quantity > 0) {
        const movement = await postStockMovement({
          hotelId: req.hotelId, propertyId: req.propertyId, itemId: item._id,
          movementType: 'issue', quantity: convertedConsumption.quantity, unit: item.baseUnit || item.unit,
          location: selectedLocation, locationId: storageLocation._id, referenceNumber: `VER-${verification._id}`,
          department: consumptionDepartment,
          notes: [
            'Physical verification consumption.',
            String(consumptionReason).trim(),
            String(remarks).trim()
          ].filter(Boolean).join(' '),
          metadata: {
            source: 'stock_verification_unrecorded_consumption',
            verificationId: String(verification._id),
            periodStart: start,
            periodEnd: end
          },
          recordedBy: req.user._id, idempotencyKey: `verification:${verification._id}:consumption`, session
        });
        movements.push(movement.movement._id);
      }
      if (convertedWastage.quantity > 0) {
        const movement = await postStockMovement({
          hotelId: req.hotelId, propertyId: req.propertyId, itemId: item._id,
          movementType: 'wastage', quantity: convertedWastage.quantity, unit: item.baseUnit || item.unit,
          location: selectedLocation, locationId: storageLocation._id, referenceNumber: `VER-${verification._id}`,
          notes: [
            'Physical verification wastage.',
            String(wastageReason).trim(),
            String(remarks).trim()
          ].filter(Boolean).join(' '),
          recordedBy: req.user._id, idempotencyKey: `verification:${verification._id}:wastage`, session
        });
        movements.push(movement.movement._id);
      }
      if (discrepancyQuantity > 0 || stockGain > 0) {
        const movementResult = await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: item._id,
          movementType: 'physical_count',
          quantity: convertedActual.quantity,
          unit: item.baseUnit || item.unit,
          location: selectedLocation,
          locationId: storageLocation._id,
          referenceNumber: `VER-${verification._id}`,
          notes: [discrepancyLabel, String(remarks).trim()].filter(Boolean).join('. '),
          recordedBy: req.user._id,
          idempotencyKey: `verification:${verification._id}:physical-count`,
          session
        });
        const [adjustment] = await StockAdjustment.create([{
          ...tenantFilter(req),
          itemId: item._id,
          quantity: convertedActual.quantity,
          unit: item.baseUnit || item.unit,
          conversionFactor: 1,
          baseUnit: item.baseUnit || item.unit,
          reason: 'physical_mismatch',
          location: selectedLocation,
          locationId: storageLocation._id,
          status: 'approved',
          reportedBy: req.user._id,
          movementId: movementResult.movement._id,
          remarks: [discrepancyLabel, String(remarks).trim()].filter(Boolean).join('. ')
        }], { session });
        verification.adjustmentId = adjustment._id;
        movements.push(movementResult.movement._id);
      }
      verification.movementIds = movements;
      await verification.save({ session });
      return { verification, duplicate: false };
    });
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'RECORD_STOCK_VERIFICATION',
        entity: 'StockVerification',
        entityId: result.verification._id,
        details: { itemId, expectedStock: result.verification.expectedStock, actualStock: result.verification.actualStock },
        req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const getStockLocations = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.itemId) {
      if (!mongoose.isValidObjectId(req.query.itemId)) {
        return res.status(400).json({ success: false, message: 'Choose a valid inventory item to view its stock locations.' });
      }
      filter.itemId = req.query.itemId;
    }
    const balances = await InventoryBalance.find(filter)
      .populate('itemId', 'name code unit currentStock unitCost')
      .sort({ location: 1 })
      .lean();
    res.json({ success: true, data: balances });
  } catch (err) {
    next(err);
  }
};

export const transferStockBetweenLocations = async (req, res, next) => {
  try {
    const {
      itemId, quantity, fromLocation, toLocation, fromLocationId, toLocationId, department, notes,
      transferMode, fromDepartment, toDepartment
    } = req.body;
    const result = await runInventoryTransaction((session) => transferStock({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemId,
      quantity,
      unit: req.body.unit,
      fromLocation,
      toLocation,
      fromLocationId,
      toLocationId,
      department: department || '',
      transferMode: transferMode || 'location',
      fromDepartment: fromDepartment || '',
      toDepartment: toDepartment || '',
      recordedBy: req.user._id,
      referenceNumber: generateReference('TRF'),
      idempotencyKey: req.body.idempotencyKey || req.get('Idempotency-Key'),
      notes: notes || '',
      session
    }));
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      message: result.duplicate ? 'Stock transfer was already recorded.' : 'Stock transferred successfully.',
      data: result
    });
  } catch (err) {
    next(err);
  }
};

export const cancelStockTransfer = async (req, res, next) => {
  try {
    const result = await runInventoryTransaction((session) => cancelTransfer({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      transferId: req.params.id,
      recordedBy: req.user._id,
      notes: req.body?.notes || '',
      idempotencyKey: req.body?.idempotencyKey || req.get('Idempotency-Key'),
      session
    }));
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'CANCEL_STOCK_TRANSFER',
        entity: 'StockMovement',
        entityId: result.movements?.[0]?._id || req.params.id,
        details: {
          transferId: req.params.id,
          cancelledReferenceNumber: result.originals?.[0]?.referenceNumber || null
        },
        req
      });
    }
    res.json({
      success: true,
      message: result.duplicate
        ? 'Stock transfer was already cancelled.'
        : 'Stock transfer cancelled; both locations were reversed.',
      data: result
    });
  } catch (err) {
    next(err);
  }
};

export const getStockLedger = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, itemId, movementType, department, location, from, to } = req.query;
    const filter = tenantFilter(req);
    if (itemId) filter.itemId = itemId;
    if (movementType) filter.movementType = movementType;
    if (department) filter.department = department;
    if (location) filter.location = location;
    const createdAt = dateFilter({ from, to });
    if (createdAt) filter.createdAt = createdAt;
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 50));
    const [data, total] = await Promise.all([
      StockMovement.find(filter)
        .populate('itemId', 'name code unit')
        .populate('recordedBy', 'name')
        .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      StockMovement.countDocuments(filter)
    ]);
    res.json({ success: true, data, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
  } catch (err) {
    next(err);
  }
};

export const getGoodsReceipts = async (req, res, next) => {
  try {
    const data = await GoodsReceipt.find(tenantFilter(req))
      .populate('purchaseOrderId', 'poNumber vendorId')
      .populate('receivedBy', 'name')
      .populate('lines.itemId', 'name code unit')
      .sort({ receivedAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 50))
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getStockAdjustments = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    const limit = Math.min(200, Number(req.query.limit) || 100);
    const [adjustments, wastageMovements] = await Promise.all([
      StockAdjustment.find(filter)
        .populate('itemId', 'name code unit baseUnit')
        .populate('reportedBy approvedBy', 'name')
        .populate({
          path: 'movementId',
          populate: { path: 'batchAllocations.batchId', select: 'batchNumber' }
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      req.query.status
        ? []
        : StockMovement.find({
          ...tenantFilter(req),
          movementType: { $in: ['wastage', 'expiry'] }
        })
          .populate('itemId', 'name code unit baseUnit')
          .populate('recordedBy', 'name')
          .populate('batchAllocations.batchId', 'batchNumber')
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean()
    ]);
    const adjustmentMovementIds = new Set(
      adjustments.map((adjustment) => String(adjustment.movementId?._id || '')).filter(Boolean)
    );
    const data = [
      ...adjustments.map((adjustment) => ({ ...adjustment, recordType: 'adjustment' })),
      ...wastageMovements
        .filter((movement) => !adjustmentMovementIds.has(String(movement._id)))
        .map((movement) => ({ ...movement, recordType: 'wastage' }))
    ]
      .sort((left, right) => (
        new Date(right.movementId?.createdAt || right.createdAt)
        - new Date(left.movementId?.createdAt || left.createdAt)
      ))
      .slice(0, limit);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createStockAdjustment = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const { itemId, quantity, reason, department, location, locationId, remarks } = req.body;
    const amount = Number(quantity);
    const reasons = ['expired', 'damaged', 'food_wastage', 'spillage', 'missing', 'physical_mismatch', 'internal_usage'];
    const departments = ['Kitchen', 'Restaurant', 'Production', 'Housekeeping', 'Maintenance', 'Minibar'];
    if (!mongoose.isValidObjectId(itemId) || !Number.isFinite(amount) || amount < 0
      || (amount === 0 && reason !== 'physical_mismatch') || !reasons.includes(reason)
      || !departments.includes(department)) {
      return res.status(400).json({ success: false, message: 'Provide a valid item, non-negative physical count or positive adjustment quantity, supported reason, and department.' });
    }
    const item = await InventoryItem.findOne({ _id: itemId, ...tenantFilter(req), isActive: true })
      .select('name unit baseUnit packagingOptions unitConversions');
    if (!item) return res.status(404).json({ success: false, message: 'Active inventory item not found.' });
    const unit = normalizeInventoryUnit(req.body.unit || item.baseUnit || item.unit);
    const converted = convertQuantityToBase(item, amount, unit);
    const result = await runInventoryTransaction(async (session) => {
      const storageLocation = await resolveStorageLocation({
        hotelId: req.hotelId,
        locationId,
        locationName: location || 'Main Store',
        session
      });
      const [adjustment] = await StockAdjustment.create([{
        ...tenantFilter(req),
        itemId,
        quantity: amount,
        unit: converted.unit,
        baseUnit: item.baseUnit || item.unit,
        conversionFactor: converted.factor,
        reason,
        department: department || '',
        location: storageLocation.locationName,
        locationId: storageLocation._id,
        remarks: remarks || '',
        status: 'approved',
        reportedBy: req.user._id
      }], { session });
      const movementType = {
        expired: 'expiry',
        damaged: 'wastage',
        food_wastage: 'wastage',
        spillage: 'wastage',
        missing: 'wastage',
        physical_mismatch: 'physical_count',
        internal_usage: 'issue'
      }[reason];
      const movement = await postStockMovement({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        itemId,
        movementType,
        quantity: amount,
        unit: converted.unit,
        conversionFactor: converted.factor,
        location: storageLocation.locationName,
        locationId: storageLocation._id,
        department: department || '',
        referenceNumber: `ADJ-${adjustment._id}`,
        notes: `${reason}: ${remarks || ''}`.trim(),
        recordedBy: req.user._id,
        idempotencyKey: `stock-adjustment:${adjustment._id}`,
        session
      });
      adjustment.movementId = movement.movement._id;
      await adjustment.save({ session });
      return adjustment;
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'RECORD_STOCK_ADJUSTMENT',
      entity: 'StockAdjustment',
      entityId: result._id,
      details: { itemId: String(result.itemId), quantity: result.quantity, reason: result.reason },
      req
    });
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

const resolveMinibarRoom = async (req, session) => {
  const room = await Room.findOne({
    _id: req.params.roomId,
    ...tenantFilter(req),
    isActive: true
  }).session(session);
  if (!room) throw Object.assign(new Error('Room not found in this property.'), { statusCode: 404 });
  return room;
};

export const getMinibarRooms = async (req, res, next) => {
  try {
    const rooms = await Room.find({ ...tenantFilter(req), isActive: true })
      .select('roomNumber roomStatus')
      .sort({ roomNumber: 1 })
      .lean();
    res.json({ success: true, data: rooms });
  } catch (err) {
    next(err);
  }
};

export const getMinibarRoomStock = async (req, res, next) => {
  try {
    const room = await resolveMinibarRoom(req);
    const [stock, transactions] = await Promise.all([
      MinibarStock.find({ ...tenantFilter(req), roomId: room._id })
        .populate('itemId', 'name code unit baseUnit baseUnitId purchaseUnit purchaseUnitId packagingOptions additionalPackagingOptions unitConversions sellingPrice unitCost')
        .sort({ 'itemId.name': 1 })
        .lean(),
      MinibarTransaction.find({ ...tenantFilter(req), roomId: room._id })
        .populate('itemId', 'name code unit')
        .populate('recordedBy', 'name')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    ]);
    res.json({ success: true, data: { room, stock, transactions } });
  } catch (err) {
    next(err);
  }
};

export const assignMinibarStock = async (req, res, next) => {
  try {
    const { items, idempotencyKey } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'At least one minibar item and quantity are required.' });
    }
    const requestKey = String(idempotencyKey || req.get('Idempotency-Key') || generateReference('MB'));
    if (requestKey.length > 120) return res.status(400).json({ success: false, message: 'Idempotency key is too long.' });
    const result = await runInventoryTransaction(async (session) => {
      const alreadyRecorded = await MinibarTransaction.findOne({
        ...tenantFilter(req),
        idempotencyKey: { $in: items.map((line) => `${requestKey}:${line.itemId}:record`) }
      }).session(session);
      if (alreadyRecorded) return { duplicate: true, transactions: [] };
      const room = await resolveMinibarRoom(req, session);
      const transactions = [];
      for (const line of items) {
        const quantity = Number(line.quantity);
        if (!mongoose.isValidObjectId(line.itemId) || !Number.isFinite(quantity) || quantity <= 0) {
          throw Object.assign(new Error('Minibar assignment quantities must be positive.'), { statusCode: 400 });
        }
        const item = await InventoryItem.findOne({
          _id: line.itemId, ...tenantFilter(req), isActive: true
        }).session(session);
        if (!item) throw Object.assign(new Error('Minibar item not found.'), { statusCode: 404 });
        const roomLocation = `Room ${room.roomNumber}`;
        const movement = await transferStock({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: item._id,
          quantity,
          unit: line.unit || undefined,
          fromLocation: line.fromLocation || 'Minibar Store',
          fromLocationId: line.fromLocationId,
          toLocation: roomLocation,
          department: 'Minibar',
          recordedBy: req.user._id,
          referenceNumber: `MINIBAR-${room.roomNumber}`,
          idempotencyKey: `${requestKey}:${item._id}:transfer`,
          session
        });
        let stock = await MinibarStock.findOne({
          ...tenantFilter(req), roomId: room._id, itemId: item._id
        }).session(session);
        if (stock) {
          stock.quantity += movement.movements[0].quantity;
          await stock.save({ session });
        } else {
          [stock] = await MinibarStock.create([{
            ...tenantFilter(req), roomId: room._id, itemId: item._id,
            openingQuantity: movement.movements[0].quantity, quantity: movement.movements[0].quantity
          }], { session });
        }
        const [transaction] = await MinibarTransaction.create([{
          ...tenantFilter(req),
          roomId: room._id,
          itemId: item._id,
          type: 'replenishment',
          quantity: movement.movements[0].quantity,
          enteredQuantity: quantity,
          unit: line.unit || item.baseUnit || item.unit,
          conversionFactor: movement.movements[0].conversionFactor,
          idempotencyKey: `${requestKey}:${item._id}:record`,
          recordedBy: req.user._id
        }], { session });
        transactions.push({ transaction, stock, movement });
      }
      return { duplicate: false, transactions };
    });
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const reconcileMinibar = async (req, res, next) => {
  try {
    const { items, idempotencyKey, notes = '' } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'At least one minibar reconciliation line is required.' });
    }
    const requestKey = String(idempotencyKey || req.get('Idempotency-Key') || generateReference('MB'));
    if (requestKey.length > 120) return res.status(400).json({ success: false, message: 'Idempotency key is too long.' });
    const result = await runInventoryTransaction(async (session) => {
      const alreadyRecorded = await MinibarTransaction.findOne({
        ...tenantFilter(req),
        idempotencyKey: {
          $in: items.flatMap((line) => ['consumption', 'complimentary', 'damaged', 'missing']
            .map((type) => `${requestKey}:${line.itemId}:${type}:record`))
        }
      }).session(session);
      if (alreadyRecorded) return { duplicate: true, transactions: [] };
      const room = await resolveMinibarRoom(req, session);
      const reservation = await Reservation.findOne({
        hotelId: req.hotelId,
        propertyId: req.propertyId,
        status: 'checked_in',
        'rooms.roomId': room._id
      }).session(session);
      const invoice = reservation
        ? await Invoice.findOne({ hotelId: req.hotelId, propertyId: req.propertyId, reservationId: reservation._id }).session(session)
        : null;
      const recorded = [];
      for (const line of items) {
        const stock = await MinibarStock.findOne({
          ...tenantFilter(req), roomId: room._id, itemId: line.itemId
        }).session(session);
        if (!stock) throw Object.assign(new Error('Minibar stock item is not assigned to this room.'), { statusCode: 404 });
        const item = await InventoryItem.findOne({
          _id: stock.itemId, ...tenantFilter(req), isActive: true
        }).session(session);
        if (!item) throw Object.assign(new Error('Minibar item is no longer active.'), { statusCode: 409 });
        const enteredQuantities = {
          consumption: Number(line.consumedQuantity || 0),
          complimentary: Number(line.complimentaryQuantity || 0),
          damaged: Number(line.damagedQuantity || 0),
          missing: Number(line.missingQuantity || 0)
        };
        const unit = normalizeInventoryUnit(line.unit || item.baseUnit || item.unit);
        const conversionFactor = getUnitConversionFactor(item, unit);
        const quantities = Object.fromEntries(
          Object.entries(enteredQuantities).map(([type, quantity]) => [
            type,
            convertQuantityToBase(item, quantity, unit, conversionFactor).quantity
          ])
        );
        if (!Object.values(enteredQuantities).every((quantity) => Number.isFinite(quantity) && quantity >= 0)
          || Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0) > stock.quantity) {
          throw Object.assign(new Error(`Reconciled quantity exceeds available minibar stock for ${item.name}.`), { statusCode: 409 });
        }
        const chargedQuantity = quantities.consumption;
        const unitPrice = item.sellingPrice ?? item.unitCost;
        const chargeAmount = Math.round(chargedQuantity * unitPrice * 100) / 100;
        if (chargeAmount > 0 && (!reservation || !invoice)) {
          throw Object.assign(new Error('A checked-in guest reservation and invoice are required to charge minibar consumption.'), { statusCode: 409 });
        }
        const totalDeducted = Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
        if (totalDeducted > 0) {
          const updated = await MinibarStock.updateOne({
            _id: stock._id, quantity: { $gte: totalDeducted }
          }, { $inc: { quantity: -totalDeducted } }, { session });
          if (updated.modifiedCount !== 1) throw Object.assign(new Error('Minibar stock changed concurrently; reconcile again.'), { statusCode: 409 });
        }
        for (const [type, quantity] of Object.entries(quantities)) {
          if (!quantity) continue;
          const movementType = type === 'damaged' || type === 'missing' ? 'wastage' : 'issue';
          const movement = await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: item._id,
            movementType,
            quantity: enteredQuantities[type],
            unit,
            conversionFactor,
            location: `Room ${room.roomNumber}`,
            department: 'Minibar',
            referenceNumber: `ROOM-${room.roomNumber}`,
            notes: `${type} minibar item. ${notes}`.trim(),
            recordedBy: req.user._id,
            idempotencyKey: `${requestKey}:${item._id}:${type}`,
            session
          });
          const [transaction] = await MinibarTransaction.create([{
            ...tenantFilter(req),
            roomId: room._id,
            itemId: item._id,
            reservationId: reservation?._id || null,
            invoiceId: chargeAmount > 0 && type === 'consumption' ? invoice._id : null,
            type,
            quantity,
            enteredQuantity: enteredQuantities[type],
            unit,
            conversionFactor,
            unitPrice: type === 'consumption' ? unitPrice : 0,
            chargeAmount: type === 'consumption' ? chargeAmount : 0,
            idempotencyKey: `${requestKey}:${item._id}:${type}:record`,
            recordedBy: req.user._id,
            notes
          }], { session });
          recorded.push({ transaction, movement: movement.movement });
        }
        if (chargeAmount > 0) {
          invoice.items.push({
            description: `Minibar: ${item.name} (Room ${room.roomNumber})`,
            quantity: chargedQuantity,
            unitPrice,
            amount: chargeAmount,
            itemType: 'amenity',
            sourceRef: `${room._id}:${item._id}:${requestKey}`
          });
          invoice.subtotal = Math.round((invoice.subtotal + chargeAmount) * 100) / 100;
          invoice.totalAmount = Math.round((invoice.totalAmount + chargeAmount) * 100) / 100;
          invoice.balanceAmount = Math.round((invoice.totalAmount - invoice.paidAmount) * 100) / 100;
          reservation.totalAmount = Math.round((reservation.totalAmount + chargeAmount) * 100) / 100;
          reservation.balanceAmount = Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100;
        }
      }
      if (invoice && recorded.length) await invoice.save({ session });
      if (reservation && recorded.length) await reservation.save({ session });
      return { duplicate: false, transactions: recorded };
    });
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const approvePurchaseOrder = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const pendingOrder = await PurchaseOrder.findOne({
      _id: req.params.id,
      ...tenantFilter(req),
      status: { $in: ['draft', 'pending_approval'] }
    });
    if (!pendingOrder) return res.status(404).json({ success: false, message: 'Pending purchase order not found.' });
    if (!pendingOrder.vendorId) {
      return res.status(400).json({ success: false, message: 'Select a supplier before approving this purchase order.' });
    }
    const activeVendor = await Vendor.findOne({
      _id: pendingOrder.vendorId,
      hotelId: req.hotelId,
      status: 'active'
    }).select('_id');
    if (!activeVendor) {
      return res.status(400).json({ success: false, message: 'Select an active supplier before approving this purchase order.' });
    }
    const po = await PurchaseOrder.findOneAndUpdate({
      _id: pendingOrder._id,
      ...tenantFilter(req),
      status: { $in: ['draft', 'pending_approval'] }
    }, {
      $set: {
        status: 'ordered',
        approvedBy: req.user._id,
        approvedAt: new Date(),
        autoReorderItemId: null
      }
    }, { new: true, runValidators: true });
    if (!po) return res.status(409).json({ success: false, message: 'Purchase order status changed; refresh and try again.' });
    await logAudit({
      hotelId: req.hotelId,
      action: 'APPROVE_INVENTORY_PURCHASE_ORDER',
      entity: 'PurchaseOrder',
      entityId: po._id,
      details: { poNumber: po.poNumber },
      req
    });
    res.json({ success: true, data: po });
  } catch (err) {
    next(err);
  }
};

export const getReorderSuggestions = async (req, res, next) => {
  try {
    const [items, openOrders, expiredBatches] = await Promise.all([
      InventoryItem.find({ ...tenantFilter(req), isActive: true })
        .select('name code unit baseUnit baseUnitId purchaseUnit purchaseUnitId preferredPurchaseUnitId purchaseConversionFactor supportedUnits packagingOptions unitConversions currentStock minStockThreshold reorderLevel maxStockLevel reorderQuantity unitCost purchasePrice vendorId inventoryType')
        .lean(),
      PurchaseOrder.find({ ...tenantFilter(req), status: { $in: ['draft', 'pending_approval', 'ordered', 'partially_received', 'approved'] } })
        .select('items status').lean(),
      InventoryBatch.aggregate([
        { $match: { ...tenantFilter(req), expiryDate: { $lte: new Date() }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ])
    ]);
    const pending = new Map();
    const expired = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
    for (const order of openOrders) {
      for (const line of order.items) {
        const key = String(line.itemId || '');
        pending.set(key, (pending.get(key) || 0)
          + Math.max(0, line.quantity - (line.receivedQuantity || 0)) * (line.conversionFactor || 1));
      }
    }
    const data = items.filter((item) => {
      const threshold = Number(item.reorderLevel) > 0
        ? Number(item.reorderLevel)
        : Number(item.minStockThreshold || 0);
      return Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0))
        + (pending.get(String(item._id)) || 0) < threshold;
    }).map((item) => {
      const onOrder = pending.get(String(item._id)) || 0;
      const availableStock = Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0));
      const threshold = Number(item.reorderLevel) > 0
        ? Number(item.reorderLevel)
        : Number(item.minStockThreshold || 0);
      const target = Math.max(
        threshold,
        Number(item.maxStockLevel) > 0 ? Number(item.maxStockLevel) : Number(item.reorderQuantity || 0)
      );
      const activeSupportedUnits = (item.supportedUnits || []).filter((unit) => unit.isActive !== false);
      const preferredUnitId = String(item.preferredPurchaseUnitId || item.purchaseUnitId || '');
      const configuredPurchaseUnit = activeSupportedUnits.find((unit) => (
        unit.isActive !== false
        && String(unit.unitId?._id || unit.unitId || '') === preferredUnitId
        && unit.isDefaultPurchaseUnit
      )) || activeSupportedUnits.find((unit) => (
        String(unit.unitId?._id || unit.unitId || '') === preferredUnitId
      )) || activeSupportedUnits.find((unit) => unit.isDefaultPurchaseUnit);
      const suggestedUnit = configuredPurchaseUnit?.unitSymbolSnapshot
        || item.purchaseUnit
        || item.baseUnit
        || item.unit;
      const factor = Number(configuredPurchaseUnit?.conversionFactorToBase)
        || getUnitConversionFactor(item, suggestedUnit);
      const suggestedBaseQuantity = Math.max(0, target - availableStock - onOrder);
      return {
        ...item,
        availableStock,
        pendingPurchaseQuantity: onOrder,
        suggestedBaseQuantity,
        suggestedQuantity: Math.ceil(suggestedBaseQuantity / factor),
        suggestedUnit
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getDepartmentRequests = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.department) filter.department = req.query.department;
    const data = await DepartmentRequest.find(filter)
      .populate('requestedBy approvedBy', 'name')
      .populate('lines.itemId', 'name code unit currentStock')
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit) || 100))
      .lean();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createDepartmentRequest = async (req, res, next) => {
  try {
    const { department, lines, notes } = req.body;
    if (!department?.trim() || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ success: false, message: 'Department and at least one requested item are required.' });
    }
    const parsedLines = [];
    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ success: false, message: 'Requested quantities must be positive.' });
      }
      const item = await InventoryItem.findOne({
        _id: line.itemId, ...tenantFilter(req), isActive: true
      }).select('name unit baseUnit purchaseUnit packagingOptions unitConversions');
      if (!item) return res.status(400).json({ success: false, message: 'Request contains an invalid inventory item.' });
      const unit = normalizeInventoryUnit(line.unit || item.baseUnit || item.unit);
      const converted = convertQuantityToBase(item, quantity, unit);
      parsedLines.push({
        itemId: line.itemId,
        quantity,
        baseQuantity: converted.quantity,
        unit: converted.unit,
        conversionFactor: converted.factor
      });
    }
    const [request] = await DepartmentRequest.create([{
      ...tenantFilter(req),
      department: department.trim(),
      lines: parsedLines,
      notes: notes || '',
      requestedBy: req.user._id
    }]);
    res.status(201).json({ success: true, data: request });
  } catch (err) {
    next(err);
  }
};

export const reviewDepartmentRequest = async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const { decision, lines } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be approve or reject.' });
    }
    const result = await runInventoryTransaction(async (session) => {
      const request = await DepartmentRequest.findOne({
        _id: req.params.id, ...tenantFilter(req), status: 'pending'
      }).session(session);
      if (!request) throw Object.assign(new Error('Pending department request not found.'), { statusCode: 404 });
      if (decision === 'reject') {
        request.status = 'rejected';
        request.approvedBy = req.user._id;
        request.approvedAt = new Date();
        await request.save({ session });
        return request;
      }
      const issuedLines = lines || request.lines;
      for (const input of issuedLines) {
        const line = request.lines.find((candidate) => String(candidate.itemId) === String(input.itemId));
        if (!line) throw Object.assign(new Error('Issue contains an item that was not requested.'), { statusCode: 400 });
        const quantity = Number(input.quantity ?? line.quantity);
        const unit = normalizeInventoryUnit(input.unit || line.unit);
        const requestedFactor = line.unit === unit && line.conversionFactor
          ? line.conversionFactor
          : getUnitConversionFactor(
            await InventoryItem.findOne({ _id: line.itemId, ...tenantFilter(req) })
              .select('name unit baseUnit packagingOptions unitConversions'),
            unit
          );
        const conversionFactor = requestedFactor;
        const baseQuantity = quantity * conversionFactor;
        if (!Number.isFinite(quantity) || quantity <= 0
          || baseQuantity > (line.baseQuantity ?? line.quantity * (line.conversionFactor || 1))) {
          throw Object.assign(new Error('Issued quantity must be positive and cannot exceed the requested quantity.'), { statusCode: 400 });
        }
        await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: line.itemId,
          movementType: 'department_issue',
          quantity,
          unit,
          conversionFactor,
          location: input.location || 'Main Store',
          department: request.department,
          referenceNumber: `REQ-${request._id}`,
          notes: request.notes || 'Approved department stock issue',
          recordedBy: req.user._id,
          idempotencyKey: `department-request:${request._id}:${line.itemId}`,
          session
        });
        line.issuedQuantity = baseQuantity;
        line.issuedEnteredQuantity = quantity;
        line.issuedUnit = unit;
        line.issuedConversionFactor = conversionFactor;
      }
      request.status = request.lines.every((line) => (
        line.issuedQuantity >= (line.baseQuantity ?? line.quantity * (line.conversionFactor || 1))
      )) ? 'issued' : 'partially_issued';
      request.approvedBy = req.user._id;
      request.approvedAt = new Date();
      await request.save({ session });
      return request;
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

export const getRecipes = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.menuItemId) filter.menuItemId = req.query.menuItemId;
    const recipes = await InventoryRecipe.find(filter)
      .populate('menuItemId', 'name price acPrice acPricingEnabled nonAcPrice nonAcPricingEnabled')
      .populate('ingredients.itemId', 'name code unit baseUnit unitCost purchasePrice purchaseConversionFactor')
      .populate('ingredients.substitutions.itemId', 'name code unit baseUnit')
      .sort({ menuItemId: 1, version: -1 })
      .lean();
    const itemIds = [...new Set(recipes.flatMap((recipe) => recipe.ingredients.map((ingredient) => (
      String(ingredient.itemId?._id || ingredient.itemId)
    ))))].filter((id) => mongoose.isValidObjectId(id));
    const unitCosts = await getInventoryBatchAverageCosts({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      itemIds
    });
    const roundMoney = (amount) => Math.round((amount + Number.EPSILON) * 100) / 100;
    const data = recipes.map((recipe) => {
      let totalRecipeCost = 0;
      let ingredientCostPending = false;
      recipe.ingredients.forEach((ingredient) => {
        if (ingredient.optional) return;
        const item = ingredient.itemId;
        const quantity = Number(ingredient.quantity);
        const conversionFactor = Number(ingredient.conversionFactor || 1);
        const itemId = String(item?._id);
        const purchasePrice = item?.purchasePrice;
        const purchaseConversionFactor = Number(item?.purchaseConversionFactor);
        const purchaseUnitCost = purchasePrice !== null && purchasePrice !== undefined
          && Number.isFinite(Number(purchasePrice))
          && Number.isFinite(purchaseConversionFactor)
          && purchaseConversionFactor > 0
          ? Number(purchasePrice) / purchaseConversionFactor
          : null;
        const storedUnitCost = Number(item?.unitCost);
        const baseUnitCost = unitCosts.has(itemId)
          ? unitCosts.get(itemId)
          : purchaseUnitCost ?? (
            Number.isFinite(storedUnitCost) && storedUnitCost > 0 ? storedUnitCost : null
          );
        if (!Number.isFinite(quantity) || quantity <= 0
          || !Number.isFinite(conversionFactor) || conversionFactor <= 0
          || baseUnitCost === null || !Number.isFinite(baseUnitCost)) {
          ingredientCostPending = true;
          return;
        }
        totalRecipeCost += quantity * conversionFactor * baseUnitCost;
      });
      const hasSellingPrice = recipe.menuItemId?.price !== null
        && recipe.menuItemId?.price !== undefined
        && recipe.menuItemId?.price !== '';
      const sellingPrice = hasSellingPrice && Number.isFinite(Number(recipe.menuItemId.price))
        ? Number(recipe.menuItemId.price)
        : null;
      const expectedProductionYield = recipe.expectedProductionYield === null
        || recipe.expectedProductionYield === undefined
        || recipe.expectedProductionYield === ''
        ? null
        : Number(recipe.expectedProductionYield);
      const validYield = Number.isFinite(expectedProductionYield) && expectedProductionYield > 0;
      const expectedPreparationLossPercent = Number(recipe.expectedPreparationLossPercent) || 0;
      const expectedPreparationLossQuantity = validYield
        ? expectedProductionYield * expectedPreparationLossPercent / 100
        : null;
      const expectedUsableQuantity = validYield
        ? expectedProductionYield - expectedPreparationLossQuantity
        : null;
      const totalCost = ingredientCostPending ? null : roundMoney(totalRecipeCost);
      const validUsableYield = Number.isFinite(expectedUsableQuantity) && expectedUsableQuantity > 0;
      const estimatedRecipeCost = totalCost !== null && validUsableYield
        ? roundMoney(totalCost / expectedUsableQuantity)
        : null;
      const getDiningPrice = (enabled, value, fallback = null) => {
        if (!enabled) return null;
        const priceValue = value ?? fallback;
        return priceValue !== null && priceValue !== undefined && priceValue !== ''
          && Number.isFinite(Number(priceValue))
          ? Number(priceValue)
          : null;
      };
      const acSellingPrice = getDiningPrice(
        recipe.menuItemId?.acPricingEnabled === true,
        recipe.menuItemId?.acPrice
      );
      const nonAcSellingPrice = getDiningPrice(
        recipe.menuItemId?.nonAcPricingEnabled !== false,
        recipe.menuItemId?.nonAcPrice,
        recipe.menuItemId?.price
      );
      const getDiningProfit = (diningSellingPrice) => ({
        sellingPrice: diningSellingPrice,
        estimatedGrossProfit: estimatedRecipeCost !== null && diningSellingPrice !== null
          ? roundMoney(diningSellingPrice - estimatedRecipeCost)
          : null,
        estimatedProfitWhole: totalCost !== null && validUsableYield && diningSellingPrice !== null
          ? roundMoney(diningSellingPrice * expectedUsableQuantity - totalCost)
          : null,
        foodCostPercent: estimatedRecipeCost !== null && diningSellingPrice > 0
          ? Math.round((estimatedRecipeCost / diningSellingPrice) * 10000) / 100
          : null
      });
      const acPricing = getDiningProfit(acSellingPrice);
      const nonAcPricing = getDiningProfit(nonAcSellingPrice);
      const estimatedGrossProfit = estimatedRecipeCost !== null && sellingPrice !== null
        ? roundMoney(sellingPrice - estimatedRecipeCost)
        : null;
      return {
        ...recipe,
        totalRecipeCost: totalCost,
        estimatedRecipeCost,
        costPerServing: estimatedRecipeCost,
        sellingPrice,
        expectedProductionYield,
        expectedPreparationLossPercent,
        expectedPreparationLossQuantity,
        expectedUsableQuantity,
        costPending: ingredientCostPending,
        diningTypePricing: {
          ac: { enabled: recipe.menuItemId?.acPricingEnabled === true, ...acPricing },
          nonAc: { enabled: recipe.menuItemId?.nonAcPricingEnabled !== false, ...nonAcPricing }
        },
        estimatedGrossProfit,
        estimatedProfitWhole: totalCost !== null && validUsableYield && sellingPrice !== null
          ? roundMoney(sellingPrice * expectedUsableQuantity - totalCost)
          : null,
        foodCostPercent: estimatedRecipeCost !== null && sellingPrice > 0
          ? Math.round((estimatedRecipeCost / sellingPrice) * 10000) / 100
          : null
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getRecipeIngredientBatchDetails = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Choose a valid recipe.' });
    }
    const recipe = await InventoryRecipe.findOne({
      _id: req.params.id,
      ...tenantFilter(req)
    })
      .populate('ingredients.itemId', 'name unit baseUnit unitCost trackExpiry trackBatchNumber')
      .lean();
    if (!recipe) {
      return res.status(404).json({ success: false, message: 'Recipe not found.' });
    }

    const itemIds = recipe.ingredients
      .map((ingredient) => ingredient.itemId?._id)
      .filter(Boolean);
    const batches = await InventoryBatch.find({
      ...tenantFilter(req),
      itemId: { $in: itemIds },
      $or: [
        ...(recipe.locationId ? [{ locationId: recipe.locationId }] : []),
        { locationId: null, location: recipe.location || 'Restaurant Store' }
      ]
    })
      .populate('vendorId', 'name')
      .select('itemId location batchNumber quantity remainingQuantity unitCost purchaseQuantity purchaseUnit purchaseUnitCost purchaseAmount receivedAt expiryDate vendorId')
      .sort({ receivedAt: 1, _id: 1 })
      .lean();
    const batchesByItem = new Map();
    batches.forEach((batch) => {
      const key = String(batch.itemId);
      const itemBatches = batchesByItem.get(key) || [];
      itemBatches.push(batch);
      batchesByItem.set(key, itemBatches);
    });
    const now = new Date();
    const details = recipe.ingredients.map((ingredient) => {
      const item = ingredient.itemId;
      if (!item) {
        return {
          itemId: String(ingredient.itemId || ''),
          itemName: 'Unknown inventory item',
          optional: Boolean(ingredient.optional),
          recipeQuantity: Number(ingredient.quantity) || 0,
          unit: ingredient.unit,
          allocations: [],
          legacyAllocation: null,
          shortageQuantity: 0
        };
      }

      const itemBatches = batchesByItem.get(String(item._id)) || [];
      const hasExpiryBatches = itemBatches.some((batch) => batch.expiryDate);
      const expiryTracked = item.trackExpiry || hasExpiryBatches;
      const eligibleBatches = itemBatches
        .filter((batch) => Number(batch.remainingQuantity) > 0
          && (!expiryTracked || !batch.expiryDate || new Date(batch.expiryDate) > now))
        .sort((left, right) => {
          if (expiryTracked) {
            const leftExpiry = left.expiryDate ? new Date(left.expiryDate).getTime() : Number.POSITIVE_INFINITY;
            const rightExpiry = right.expiryDate ? new Date(right.expiryDate).getTime() : Number.POSITIVE_INFINITY;
            if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
          }
          return new Date(left.receivedAt).getTime() - new Date(right.receivedAt).getTime()
            || String(left._id).localeCompare(String(right._id));
        });
      const quantityPerYield = Number(ingredient.quantity) || 0;
      const requiredQuantity = ingredient.optional
        ? 0
        : recipe.productionMode === 'batch_production'
          ? quantityPerYield
          : quantityPerYield / (Number(recipe.expectedProductionYield) || 1);
      const conversionFactor = Number(ingredient.conversionFactor) > 0
        ? Number(ingredient.conversionFactor)
        : 1;
      let requiredBaseQuantity = requiredQuantity * conversionFactor;
      const allocations = [];
      for (const batch of eligibleBatches) {
        if (requiredBaseQuantity <= 0) break;
        const quantity = Math.min(Number(batch.remainingQuantity), requiredBaseQuantity);
        if (quantity <= 0) continue;
        const unitCost = Number(batch.unitCost) || 0;
        allocations.push({
          batchId: String(batch._id),
          batchNumber: batch.batchNumber || '',
          location: batch.location,
          receivedAt: batch.receivedAt,
          expiryDate: batch.expiryDate,
          availableQuantity: Number(batch.remainingQuantity) || 0,
          purchasedBaseQuantity: Number(batch.quantity) || 0,
          quantityUsed: quantity,
          unitCost,
          totalCost: Math.round((quantity * unitCost + Number.EPSILON) * 100) / 100,
          purchaseQuantity: batch.purchaseQuantity,
          purchaseUnit: batch.purchaseUnit || '',
          purchaseUnitCost: batch.purchaseUnitCost,
          purchaseAmount: batch.purchaseAmount,
          vendorName: batch.vendorId?.name || ''
        });
        requiredBaseQuantity = Math.max(0, requiredBaseQuantity - quantity);
      }

      let legacyAllocation = null;
      const isBatchConstrained = item.trackExpiry || item.trackBatchNumber || hasExpiryBatches;
      if (requiredBaseQuantity > 0 && !isBatchConstrained) {
        const unitCost = Number(item.unitCost) || 0;
        legacyAllocation = {
          quantityUsed: requiredBaseQuantity,
          unitCost,
          totalCost: Math.round((requiredBaseQuantity * unitCost + Number.EPSILON) * 100) / 100
        };
        requiredBaseQuantity = 0;
      }

      return {
        itemId: String(item._id),
        itemName: item.name,
        optional: Boolean(ingredient.optional),
        recipeQuantity: quantityPerYield,
        requiredQuantity,
        unit: ingredient.unit || item.baseUnit || item.unit,
        baseUnit: item.baseUnit || item.unit,
        conversionFactor,
        allocations,
        legacyAllocation,
        shortageQuantity: Math.max(0, requiredBaseQuantity)
      };
    });

    res.json({
      success: true,
      data: {
        location: recipe.location || 'Restaurant Store',
        productionMode: recipe.productionMode,
        expectedProductionYield: recipe.expectedProductionYield,
        ingredients: details
      }
    });
  } catch (err) {
    next(err);
  }
};

export const saveRecipe = async (req, res, next) => {
  try {
    if (!['hotel_admin', 'super_admin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can manage recipes.' });
    }
    const {
      menuItemId, ingredients, recipeName = '', description = '',
      preparationInstructions = '',
      servingSize = '1 serving', preparationTimeMinutes = 0,
      productionMode = 'made_to_order', expectedProductionYield = 1,
      expectedPreparationLossPercent = 0, locationId, location = 'Restaurant Store'
    } = req.body;
    if (!mongoose.isValidObjectId(menuItemId) || !Array.isArray(ingredients) || !ingredients.length) {
      return res.status(400).json({ success: false, message: 'Menu item and at least one ingredient are required.' });
    }
    if (!Number.isFinite(Number(preparationTimeMinutes)) || Number(preparationTimeMinutes) < 0
      || (typeof servingSize !== 'string' && typeof servingSize !== 'number')
      || !['made_to_order', 'batch_production'].includes(productionMode)
      || !Number.isFinite(Number(expectedProductionYield)) || Number(expectedProductionYield) <= 0
      || !Number.isFinite(Number(expectedPreparationLossPercent))
      || Number(expectedPreparationLossPercent) < 0 || Number(expectedPreparationLossPercent) > 100) {
      return res.status(400).json({ success: false, message: 'Serving size and preparation time are invalid.' });
    }
    const MenuItem = mongoose.model('MenuItem');
    const menuItemExists = await MenuItem.exists({ _id: menuItemId, hotelId: req.hotelId });
    if (!menuItemExists) return res.status(404).json({ success: false, message: 'Menu item not found.' });
    for (const ingredient of ingredients) {
      if (!mongoose.isValidObjectId(ingredient.itemId) || !Number.isFinite(Number(ingredient.quantity)) || Number(ingredient.quantity) <= 0) {
        return res.status(400).json({ success: false, message: 'Each recipe ingredient needs a valid item and positive quantity.' });
      }
      const ingredientItem = await InventoryItem.findOne({
        _id: ingredient.itemId, ...tenantFilter(req), isActive: true
      }).select('name unit baseUnit packagingOptions unitConversions');
      if (!ingredientItem) return res.status(400).json({ success: false, message: 'Recipe contains an invalid inventory item.' });
      const ingredientUnit = normalizeInventoryUnit(ingredient.unit || ingredientItem.baseUnit || ingredientItem.unit);
      const ingredientConversionFactor = getUnitConversionFactor(ingredientItem, ingredientUnit);
      if (!Array.isArray(ingredient.substitutions || [])) {
        return res.status(400).json({ success: false, message: 'Recipe substitutions must be a list.' });
      }
      for (const substitution of ingredient.substitutions || []) {
        if (!mongoose.isValidObjectId(substitution.itemId)
          || (substitution.quantity !== undefined && (!Number.isFinite(Number(substitution.quantity)) || Number(substitution.quantity) <= 0))) {
          return res.status(400).json({ success: false, message: 'Recipe substitutions must include a valid item and positive optional quantity.' });
        }
        const substituteItem = await InventoryItem.findOne({
          _id: substitution.itemId, ...tenantFilter(req), isActive: true
        }).select('name unit baseUnit packagingOptions unitConversions');
        if (!substituteItem) return res.status(400).json({ success: false, message: 'Recipe substitution contains an invalid inventory item.' });
        const substituteUnit = normalizeInventoryUnit(substitution.unit || substituteItem.baseUnit || substituteItem.unit);
        substitution.unit = substituteUnit;
        substitution.conversionFactor = getUnitConversionFactor(substituteItem, substituteUnit);
        substitution.baseUnit = substituteItem.baseUnit || substituteItem.unit;
      }
      ingredient.unit = ingredientUnit;
      ingredient.conversionFactor = ingredientConversionFactor;
      ingredient.baseUnit = ingredientItem.baseUnit || ingredientItem.unit;
    }
    const recipe = await runInventoryTransaction(async (session) => {
      const storageLocation = await resolveStorageLocation({
        hotelId: req.hotelId, locationId, locationName: location, session
      });
      const previous = await InventoryRecipe.findOne({
        ...tenantFilter(req), menuItemId, productionMode, isActive: true
      }).sort({ version: -1 }).session(session);
      if (previous) {
        previous.isActive = false;
        await previous.save({ session });
      }
      const version = (previous?.version || 0) + 1;
      const [created] = await InventoryRecipe.create([{
        ...tenantFilter(req),
        menuItemId,
        locationId: storageLocation._id,
        location: storageLocation.locationName,
        recipeName: String(recipeName).trim(),
        description: String(description).trim(),
        preparationInstructions: String(preparationInstructions).trim(),
        servingSize: String(servingSize).trim() || '1 serving',
        preparationTimeMinutes: Number(preparationTimeMinutes),
        expectedProductionYield: Number(expectedProductionYield),
        expectedPreparationLossPercent: Number(expectedPreparationLossPercent),
        productionMode,
        ingredients: ingredients.map((ingredient) => ({
          itemId: ingredient.itemId,
          quantity: Number(ingredient.quantity),
          unit: ingredient.unit,
          conversionFactor: ingredient.conversionFactor,
          baseUnit: ingredient.baseUnit,
          optional: Boolean(ingredient.optional),
          substitutions: ingredient.substitutions || []
        })),
        version,
        createdBy: req.user._id
      }], { session });
      return created;
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'SAVE_INVENTORY_RECIPE',
      entity: 'InventoryRecipe',
      entityId: recipe._id,
      details: { menuItemId, version: recipe.version, recipeName: recipe.recipeName },
      req
    });
    res.status(201).json({ success: true, data: recipe });
  } catch (err) {
    next(err);
  }
};

export const setRecipeStatus = async (req, res, next) => {
  try {
    if (!['hotel_admin', 'super_admin'].includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can manage recipes.' });
    }
    if (typeof req.body.isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Recipe status must be active or inactive.' });
    }
    const recipe = await runInventoryTransaction(async (session) => {
      const current = await InventoryRecipe.findOne({
        _id: req.params.id,
        ...tenantFilter(req)
      }).session(session);
      if (!current) return null;
      if (req.body.isActive) {
        await InventoryRecipe.updateMany({
          ...tenantFilter(req),
          menuItemId: current.menuItemId,
          productionMode: current.productionMode,
          _id: { $ne: current._id },
          isActive: true
        }, { $set: { isActive: false } }, { session });
      }
      current.isActive = req.body.isActive;
      await current.save({ session });
      return current;
    });
    if (!recipe) return res.status(404).json({ success: false, message: 'Recipe not found.' });
    await logAudit({
      hotelId: req.hotelId,
      action: req.body.isActive ? 'ACTIVATE_INVENTORY_RECIPE' : 'DEACTIVATE_INVENTORY_RECIPE',
      entity: 'InventoryRecipe',
      entityId: recipe._id,
      details: { isActive: recipe.isActive, version: recipe.version },
      req
    });
    res.json({ success: true, data: recipe });
  } catch (err) {
    next(err);
  }
};

export const getInventoryReport = async (req, res, next) => {
  try {
    const { type = 'stock', category, department, itemId, from, to } = req.query;
    const scope = tenantFilter(req);
    if (type === 'profit-loss') {
      const hotel = req.hotel || await Hotel.findById(req.hotelId).select('timezone');
      const timeZone = hotel?.timezone || 'UTC';
      const profitLossDateRange = hotelLocalDateFilter(from, to, timeZone);
      const [orders, lossMovements, unrecordedMovements, preparedLossMovements, directComplimentaryMovements, directUnrecordedMovements, purchaseMovements] = await Promise.all([
        FoodOrder.find({
          ...scope,
          status: { $ne: 'cancelled' },
          paymentStatus: { $in: ['paid', 'partially_paid', 'refunded'] },
          ...(profitLossDateRange ? { createdAt: profitLossDateRange } : {})
        }).select('orderNumber items subtotal discountAmount taxAmount totalAmount paidAmount refundedAmount createdAt paymentStatus diningType').lean(),
        StockMovement.find({
          ...scope,
          movementType: { $in: ['wastage', 'expiry'] },
          ...(profitLossDateRange ? {
            $or: [
              { transactionDate: profitLossDateRange },
              { transactionDate: { $exists: false }, createdAt: profitLossDateRange }
            ]
          } : {})
        }).populate('itemId', 'name code unit baseUnit')
          .select('itemId movementType totalValue quantity unitCost department sourceDepartment transactionDate createdAt referenceNumber notes metadata').lean(),
        StockMovement.find({
          ...scope,
          movementType: 'issue',
          $and: [
            {
              $or: [
                { 'metadata.source': 'stock_verification_unrecorded_consumption' },
                {
                  'metadata.source': 'manual_unrecorded_usage',
                  'metadata.directUsage.targetType': 'raw_material'
                }
              ]
            },
            ...(profitLossDateRange ? [{
              $or: [
              { transactionDate: profitLossDateRange },
              { transactionDate: { $exists: false }, createdAt: profitLossDateRange }
              ]
            }] : [])
          ]
        }).populate('itemId', 'name code unit baseUnit')
          .select('itemId totalValue quantity unitCost department transactionDate createdAt referenceNumber notes metadata').lean(),
        PreparedFoodMovement.find({
          ...scope,
          movementType: { $in: ['wastage', 'complimentary', 'unrecorded_consumption', 'staff_consumption'] },
          ...(profitLossDateRange ? { createdAt: profitLossDateRange } : {})
        }).populate('menuItemId', 'name')
          .select('menuItemId productionBatchId movementType quantity unitCost totalCost reason notes location orderNumber createdAt').lean(),
        StockMovement.find({
          ...scope,
          movementType: 'issue',
          'metadata.source': 'manual_complimentary_usage',
          ...(profitLossDateRange ? {
            $or: [
              { transactionDate: profitLossDateRange },
              { transactionDate: { $exists: false }, createdAt: profitLossDateRange }
            ]
          } : {})
        }).populate('itemId', 'name code unit baseUnit')
          .select('itemId totalValue quantity transactionDate createdAt referenceNumber notes metadata location').lean(),
        StockMovement.find({
          ...scope,
          movementType: 'issue',
          'metadata.source': 'manual_unrecorded_usage',
          'metadata.directUsage.targetType': 'menu_item',
          ...(profitLossDateRange ? {
            $or: [
              { transactionDate: profitLossDateRange },
              { transactionDate: { $exists: false }, createdAt: profitLossDateRange }
            ]
          } : {})
        }).populate('itemId', 'name code unit baseUnit')
          .select('itemId totalValue quantity transactionDate createdAt referenceNumber notes metadata location').lean(),
        StockMovement.find({
          ...scope,
          movementType: 'receipt',
          ...(profitLossDateRange ? {
            $or: [
              { transactionDate: profitLossDateRange },
              { transactionDate: { $exists: false }, createdAt: profitLossDateRange }
            ]
          } : {})
        }).select('totalValue').lean()
      ]);
      const orderIds = orders.map((order) => order._id);
      const [recipeConsumptions, preparedSales] = orderIds.length
        ? await Promise.all([
          RecipeConsumption.find({
            ...scope,
            orderId: { $in: orderIds },
            status: 'deducted'
          }).select('orderId ingredients').lean(),
          PreparedFoodMovement.find({
            ...scope,
            orderId: { $in: orderIds },
            movementType: 'sale'
          }).select('orderId menuItemId orderLineIndex quantity totalCost salesRevenue').lean()
        ])
        : [[], []];
      const recipeCostByOrderMenu = new Map();
      const preparedCostByOrderLine = new Map();
      const preparedCostByOrderMenu = new Map();
      const menuItems = new Map();
      for (const consumption of recipeConsumptions) {
        for (const ingredient of consumption.ingredients || []) {
          const menuItemId = String(ingredient.menuItemId);
          const orderMenuKey = `${String(consumption.orderId)}:${menuItemId}`;
          recipeCostByOrderMenu.set(orderMenuKey,
            (recipeCostByOrderMenu.get(orderMenuKey) || 0) + (Number(ingredient.totalCost) || 0));
        }
      }
      for (const movement of preparedSales) {
        const orderId = String(movement.orderId);
        const menuItemId = String(movement.menuItemId);
        const orderMenuKey = `${orderId}:${menuItemId}`;
        if (Number.isInteger(movement.orderLineIndex)) {
          const key = `${orderId}:${movement.orderLineIndex}`;
          preparedCostByOrderLine.set(key,
            (preparedCostByOrderLine.get(key) || 0) + (Number(movement.totalCost) || 0));
        } else {
          preparedCostByOrderMenu.set(orderMenuKey,
            (preparedCostByOrderMenu.get(orderMenuKey) || 0) + (Number(movement.totalCost) || 0));
        }
      }

      let salesRevenue = 0;
      let uncostedSalesRevenue = 0;
      let settledOrderCount = 0;
      let uncostedSalesCount = 0;
      for (const order of orders) {
        const totalAmount = Number(order.totalAmount) || 0;
        const paidAmount = Number(order.paidAmount)
          || (['paid', 'refunded'].includes(order.paymentStatus) ? totalAmount : 0);
        const refundedAmount = Math.min(totalAmount, Number(order.refundedAmount)
          || (order.paymentStatus === 'refunded' ? totalAmount : 0));
        const paidRatio = totalAmount > 0
          ? Math.min(1, Math.max(0, paidAmount - refundedAmount) / totalAmount)
          : 0;
        if (paidRatio <= 0) continue;
        settledOrderCount += 1;

        const lines = order.items || [];
        const lineAmounts = lines.map((line) => Number(line.amount ?? (
          (Number(line.quantity) || 0) * (Number(line.unitPriceSnapshot ?? line.unitPrice) || 0)
        )));
        const orderSubtotal = Number(order.subtotal) || lineAmounts.reduce((sum, amount) => sum + amount, 0);
        const discount = Number(order.discountAmount) || 0;
        const lineQuantitiesByMenu = new Map();
        lines.forEach((line) => {
          const key = String(line.menuItemId);
          lineQuantitiesByMenu.set(key, (lineQuantitiesByMenu.get(key) || 0) + (Number(line.quantity) || 0));
        });

        lines.forEach((line, lineIndex) => {
          const menuItemId = String(line.menuItemId);
          const orderMenuKey = `${String(order._id)}:${menuItemId}`;
          const lineAmount = lineAmounts[lineIndex];
          const discountShare = orderSubtotal > 0 ? discount * lineAmount / orderSubtotal : 0;
          const paidLineRevenue = Math.max(0, lineAmount - discountShare) * paidRatio;
          const menuItemQuantity = lineQuantitiesByMenu.get(menuItemId) || 0;
          const preparedLineCost = preparedCostByOrderLine.get(`${String(order._id)}:${lineIndex}`);
          const preparedMenuCost = preparedCostByOrderMenu.get(orderMenuKey);
          const recipeCost = recipeCostByOrderMenu.get(orderMenuKey);
          const lineCost = preparedLineCost !== undefined
            ? preparedLineCost
            : preparedMenuCost !== undefined
              ? preparedMenuCost * ((Number(line.quantity) || 0) / menuItemQuantity)
              : recipeCost !== undefined
                ? recipeCost * ((Number(line.quantity) || 0) / menuItemQuantity)
                : null;
          const menu = menuItems.get(menuItemId) || {
            menuItemId,
            name: line.name || 'Menu item',
            quantitySold: 0,
            salesRevenue: 0,
            foodCost: 0,
            hasCost: true,
            acQuantitySold: 0,
            nonAcQuantitySold: 0
          };
          menu.quantitySold += (Number(line.quantity) || 0) * paidRatio;
          menu.salesRevenue += paidLineRevenue;
          if (line.diningType === 'ac' || order.diningType === 'ac') menu.acQuantitySold += (Number(line.quantity) || 0) * paidRatio;
          else menu.nonAcQuantitySold += (Number(line.quantity) || 0) * paidRatio;
          if (lineCost === null) {
            menu.hasCost = false;
            uncostedSalesRevenue += paidLineRevenue;
            if ((Number(line.quantity) || 0) * paidRatio > 0) uncostedSalesCount += 1;
          } else {
            menu.foodCost += lineCost * paidRatio;
          }
          salesRevenue += paidLineRevenue;
          menuItems.set(menuItemId, menu);
        });
      }

      const menuItemBreakdown = [...menuItems.values()].map((item) => {
        const grossProfit = item.hasCost
          ? Math.round((item.salesRevenue - item.foodCost) * 100) / 100
          : null;
        return {
          ...item,
          salesRevenue: Math.round(item.salesRevenue * 100) / 100,
          foodCost: item.hasCost ? Math.round(item.foodCost * 100) / 100 : null,
          recordedFoodCost: Math.round(item.foodCost * 100) / 100,
          costStatus: item.hasCost ? 'complete' : 'missing',
          grossProfit,
          grossMarginPercent: item.hasCost && item.salesRevenue > 0
            ? Math.round((grossProfit / item.salesRevenue) * 10000) / 100
            : null
        };
      }).sort((left, right) => right.salesRevenue - left.salesRevenue);
      const costOfGoodsSold = menuItemBreakdown.reduce((sum, item) => sum + item.recordedFoodCost, 0);
      const costedSalesRevenue = Math.max(0, salesRevenue - uncostedSalesRevenue);
      const grossProfit = uncostedSalesCount > 0 ? null : salesRevenue - costOfGoodsSold;
      const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
      const stockWastageBreakdown = lossMovements.map((movement) => ({
        itemName: movement.itemId?.name || 'Inventory item',
        code: movement.itemId?.code || '',
        quantity: Number(movement.quantity) || 0,
        unit: movement.itemId?.baseUnit || movement.itemId?.unit || '',
        cost: Number(movement.totalValue) || 0,
        movementType: movement.movementType,
        department: movement.department || movement.sourceDepartment || '',
        date: movement.transactionDate || movement.createdAt,
        reference: movement.referenceNumber || '',
        reason: movement.notes || movement.metadata?.reason || ''
      }));
      const unrecordedConsumption = unrecordedMovements.map((movement) => ({
        itemName: movement.itemId?.name || 'Inventory item',
        menuItemName: movement.metadata?.directUsage?.targetType === 'menu_item'
          ? movement.metadata.directUsage.targetName
          : '',
        code: movement.itemId?.code || '',
        quantity: Number(movement.quantity) || 0,
        unit: movement.itemId?.baseUnit || movement.itemId?.unit || '',
        cost: Number(movement.totalValue) || 0,
        department: movement.department || '',
        date: movement.transactionDate || movement.createdAt,
        reference: movement.referenceNumber || '',
        reason: movement.notes || ''
      }));
      const groupDirectUsageMovements = (movements) => {
        const grouped = new Map();
        for (const movement of movements) {
          const usage = movement.metadata?.directUsage;
          if (!usage?.usageId) continue;
          const row = grouped.get(usage.usageId) || {
            usageId: usage.usageId,
            itemName: usage.targetName || movement.itemId?.name || 'Inventory item',
            targetType: usage.targetType,
            quantity: Number(usage.targetQuantity) || 0,
            unit: usage.targetUnit || (usage.targetType === 'menu_item'
              ? 'portion'
              : movement.itemId?.baseUnit || movement.itemId?.unit || ''),
            cost: 0,
            date: movement.transactionDate || movement.createdAt,
            location: movement.location || '',
            reference: movement.referenceNumber || '',
            reason: usage.reason || movement.notes || '',
            ingredients: []
          };
          row.cost += Number(movement.totalValue) || 0;
          row.ingredients.push({
            itemId: String(movement.itemId?._id || movement.itemId),
            itemName: movement.itemId?.name || 'Raw material',
            quantity: Number(movement.quantity) || 0,
            unit: movement.baseUnit || movement.itemId?.baseUnit || movement.itemId?.unit || '',
            cost: Number(movement.totalValue) || 0,
            menuItemName: usage.targetType === 'menu_item' ? usage.targetName : ''
          });
          grouped.set(usage.usageId, row);
        }
        return [...grouped.values()].map((entry) => ({ ...entry, cost: round(entry.cost) }));
      };
      const directComplimentaryUsage = groupDirectUsageMovements(directComplimentaryMovements);
      const directUnrecordedMenuUsage = groupDirectUsageMovements(directUnrecordedMovements);
      const stockWastageCost = lossMovements.reduce((sum, movement) => sum + (Number(movement.totalValue) || 0), 0);
      const unrecordedConsumptionCost = unrecordedMovements.reduce((sum, movement) => sum + (Number(movement.totalValue) || 0), 0);
      const preparedWastageBreakdown = preparedLossMovements
        .filter((movement) => movement.movementType === 'wastage')
        .map((movement) => ({
        itemName: movement.menuItemId?.name || 'Prepared food',
        quantity: Number(movement.quantity) || 0,
        unit: 'portion',
        cost: Number(movement.totalCost) || 0,
        movementType: movement.movementType,
        date: movement.createdAt,
        location: movement.location || '',
        reference: movement.orderNumber || '',
        reason: movement.reason || movement.notes || ''
        }));
      const preparedWastageCost = preparedLossMovements
        .filter((movement) => movement.movementType === 'wastage')
        .reduce((sum, movement) => sum + (Number(movement.totalCost) || 0), 0);
      const complimentaryBreakdown = preparedLossMovements
        .filter((movement) => movement.movementType === 'complimentary')
        .map((movement) => ({
          itemName: movement.menuItemId?.name || 'Prepared food',
          quantity: Number(movement.quantity) || 0,
          unit: 'portion',
          cost: Number(movement.totalCost) || 0,
          date: movement.createdAt,
          location: movement.location || '',
          reason: movement.reason || movement.notes || ''
        }))
        .concat(directComplimentaryUsage.map((entry) => ({
          itemName: entry.itemName,
          quantity: entry.quantity,
          unit: entry.unit,
          cost: entry.cost,
          date: entry.date,
          location: entry.location,
          reference: entry.reference,
          reason: entry.reason,
          targetType: entry.targetType,
          ingredients: entry.ingredients
        })));
      const unrecordedFoodBreakdown = preparedLossMovements
        .filter((movement) => movement.movementType === 'unrecorded_consumption')
        .map((movement) => ({
          itemName: movement.menuItemId?.name || 'Prepared food',
          quantity: Number(movement.quantity) || 0,
          unit: 'portion',
          cost: Number(movement.totalCost) || 0,
          date: movement.createdAt,
          location: movement.location || '',
          reference: movement.orderNumber || '',
          reason: movement.reason || movement.notes || ''
        }))
        .concat(directUnrecordedMenuUsage.map((entry) => ({
          itemName: entry.itemName,
          quantity: entry.quantity,
          unit: entry.unit,
          cost: entry.cost,
          date: entry.date,
          location: entry.location,
          reference: entry.reference,
          reason: entry.reason,
          ingredients: entry.ingredients,
          targetType: entry.targetType
        })));
      const staffConsumptionBreakdown = preparedLossMovements
        .filter((movement) => movement.movementType === 'staff_consumption')
        .map((movement) => ({
          itemName: movement.menuItemId?.name || 'Prepared food',
          quantity: Number(movement.quantity) || 0,
          unit: 'portion',
          cost: Number(movement.totalCost) || 0,
          date: movement.createdAt,
          location: movement.location || '',
          reason: movement.reason || movement.notes || ''
        }));
      const complimentaryCost = complimentaryBreakdown.reduce((sum, entry) => sum + entry.cost, 0);
      const unrecordedFoodCost = unrecordedFoodBreakdown.reduce((sum, entry) => sum + entry.cost, 0);
      const staffConsumptionCost = staffConsumptionBreakdown.reduce((sum, entry) => sum + entry.cost, 0);
      const inventoryLoss = stockWastageCost + unrecordedConsumptionCost
        + preparedWastageCost + complimentaryCost + unrecordedFoodCost + staffConsumptionCost;
      const preparedFoodMovementTypes = ['complimentary', 'unrecorded_consumption'];
      const preparedFoodBatches = await ProductionBatch.find({
        ...scope,
        _id: {
          $in: preparedLossMovements
            .filter((movement) => preparedFoodMovementTypes.includes(movement.movementType))
            .map((movement) => movement.productionBatchId)
        }
      }).select('_id batchNumber acceptedQuantity ingredients').lean();
      const preparedFoodBatchById = new Map(preparedFoodBatches.map((batch) => [String(batch._id), batch]));
      const allocatePreparedFoodRawMaterials = (movementType) => {
        const materialMap = new Map();
        for (const movement of preparedLossMovements.filter((entry) => entry.movementType === movementType)) {
          const batch = preparedFoodBatchById.get(String(movement.productionBatchId));
          if (!batch || Number(batch.acceptedQuantity) <= 0) continue;
          const portionRatio = (Number(movement.quantity) || 0) / Number(batch.acceptedQuantity);
          for (const ingredient of batch.ingredients || []) {
            const itemId = String(ingredient.itemId);
            const key = `${String(movement._id)}:${itemId}`;
            const entry = materialMap.get(key) || {
              itemId,
              itemName: ingredient.itemName || 'Raw material',
              menuItemName: movement.menuItemId?.name || 'Prepared food',
              quantity: 0,
              unit: ingredient.unit || '',
              cost: 0,
              date: movement.createdAt,
              location: movement.location || '',
              reference: batch.batchNumber || '',
              reason: movement.reason || movement.notes || ''
            };
            entry.quantity += (Number(ingredient.actualQuantity) || 0) * portionRatio;
            entry.cost += (Number(ingredient.totalCost) || 0) * portionRatio;
            materialMap.set(key, entry);
          }
        }
        return [...materialMap.values()].map((entry) => ({
          ...entry,
          quantity: round(entry.quantity),
          cost: round(entry.cost)
        }));
      };
      const complimentaryRawMaterialBreakdown = [
        ...allocatePreparedFoodRawMaterials('complimentary'),
        ...directComplimentaryUsage.flatMap((entry) => entry.ingredients.map((ingredient) => ({
          ...ingredient,
          date: entry.date,
          location: entry.location,
          reference: entry.reference,
          reason: entry.reason
        })))
      ];
      const unrecordedFoodRawMaterialBreakdown = [
        ...allocatePreparedFoodRawMaterials('unrecorded_consumption'),
        ...directUnrecordedMenuUsage.flatMap((entry) => entry.ingredients.map((ingredient) => ({
          ...ingredient,
          date: entry.date,
          location: entry.location,
          reference: entry.reference,
          reason: entry.reason
        })))
      ];
      const netProfit = grossProfit === null ? null : grossProfit - inventoryLoss;
      const rounded = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
      const roundedOrNull = (value) => value === null ? null : rounded(value);
      const topSellingItems = [...menuItemBreakdown].sort((left, right) => right.quantitySold - left.quantitySold).slice(0, 10);
      const topProfitItems = [...menuItemBreakdown]
        .filter((item) => item.grossProfit !== null)
        .sort((left, right) => right.grossProfit - left.grossProfit)
        .slice(0, 10);
      return res.json({
        success: true,
        data: [{
          salesRevenue: rounded(salesRevenue),
          costedSalesRevenue: rounded(costedSalesRevenue),
          uncostedSalesRevenue: rounded(uncostedSalesRevenue),
          uncostedSalesCount,
          costOfGoodsSold: rounded(costOfGoodsSold),
          grossProfit: roundedOrNull(grossProfit),
          grossMarginPercent: grossProfit !== null && salesRevenue > 0
            ? rounded((grossProfit / salesRevenue) * 100)
            : null,
          inventoryLoss: rounded(inventoryLoss),
          totalInventoryExpenses: rounded(costOfGoodsSold + inventoryLoss),
          netProfit: roundedOrNull(netProfit),
          netMarginPercent: netProfit !== null && salesRevenue > 0
            ? rounded((netProfit / salesRevenue) * 100)
            : null,
          stockWastageCost: rounded(stockWastageCost),
          unrecordedConsumptionCost: rounded(unrecordedConsumptionCost),
          unrecordedFoodQuantity: round(unrecordedFoodBreakdown.reduce((sum, entry) => sum + entry.quantity, 0)),
          unrecordedFoodCost: rounded(unrecordedFoodCost),
          preparedWastageCost: rounded(preparedWastageCost),
          complimentaryQuantity: round(complimentaryBreakdown
            .filter((entry) => entry.unit === 'portion' || entry.targetType === 'menu_item')
            .reduce((sum, entry) => sum + entry.quantity, 0)),
          complimentaryCost: rounded(complimentaryCost),
          staffConsumptionQuantity: round(staffConsumptionBreakdown.reduce((sum, entry) => sum + entry.quantity, 0)),
          staffConsumptionCost: rounded(staffConsumptionCost),
          stockWastageBreakdown,
          preparedWastageBreakdown,
          unrecordedConsumption,
          complimentaryBreakdown,
          complimentaryRawMaterialBreakdown,
          unrecordedFoodBreakdown,
          unrecordedFoodRawMaterialBreakdown,
          staffConsumptionBreakdown,
          stockPurchasesNotExpensed: rounded(
            purchaseMovements.reduce((sum, movement) => sum + movement.totalValue, 0)
          ),
          period: { from: from || null, to: to || null, timeZone },
          settledOrderCount,
          menuItemBreakdown,
          topSellingItems,
          topProfitItems
        }]
      });
    }
    const createdAt = dateFilter({ from, to });
    if (type === 'financial') {
      const itemFilter = {
        ...scope,
        ...(category && category !== 'all' ? { category } : {}),
        ...(itemId ? { _id: itemId } : {})
      };
      const items = await InventoryItem.find(itemFilter)
        .select('name code category currentStock unitCost')
        .lean();
      const movementFilter = {
        ...scope,
        itemId: { $in: items.map((item) => item._id) },
        ...(createdAt ? {
          $or: [
            { transactionDate: createdAt },
            { transactionDate: { $exists: false }, createdAt }
          ]
        } : {})
      };
      const movements = await StockMovement.find(movementFilter)
        .select('itemId movementType totalValue previousStock newStock quantity referenceNumber batchAllocations transactionDate createdAt')
        .populate('itemId', 'name code category unit')
        .lean();
      const [batchValues, purchaseOrders] = await Promise.all([
        InventoryBatch.aggregate([
          { $match: { ...scope, itemId: { $in: items.map((item) => item._id) }, remainingQuantity: { $gt: 0 } } },
          { $group: {
            _id: '$itemId',
            quantity: { $sum: '$remainingQuantity' },
            value: { $sum: { $multiply: ['$remainingQuantity', '$unitCost'] } }
          } }
        ]),
        PurchaseOrder.find({
          ...scope,
          poNumber: { $in: [...new Set(movements
            .filter((movement) => movement.movementType === 'receipt')
            .map((movement) => movement.referenceNumber)
            .filter(Boolean))] }
        }).populate('vendorId', 'name').select('poNumber vendorId').lean()
      ]);
      const itemTotals = new Map(items.map((item) => [String(item._id), {
        itemId: item._id,
        name: item.name,
        code: item.code,
        unit: item.unit || '',
        purchasedQuantity: 0,
        purchaseValue: 0,
        consumedQuantity: 0,
        consumptionCost: 0,
        wastedQuantity: 0,
        wastageCost: 0
      }]));
      const vendorByPO = new Map(purchaseOrders.map((order) => [order.poNumber, order.vendorId]));
      const vendorTotals = new Map();
      const monthlyTotals = new Map();
      for (const movement of movements) {
        const totals = itemTotals.get(String(movement.itemId?._id));
        if (!totals) continue;
        const transactionDate = new Date(movement.transactionDate || movement.createdAt);
        const monthKey = `${transactionDate.getFullYear()}-${String(transactionDate.getMonth() + 1).padStart(2, '0')}`;
        const monthTotal = monthlyTotals.get(monthKey) || {
          month: monthKey,
          purchaseValue: 0,
          consumptionCost: 0,
          wastageCost: 0
        };
        if (movement.movementType === 'receipt') {
          totals.purchasedQuantity += movement.quantity;
          totals.purchaseValue += movement.totalValue;
          monthTotal.purchaseValue += movement.totalValue;
          const vendor = vendorByPO.get(movement.referenceNumber);
          const vendorKey = vendor?._id ? String(vendor._id) : 'unassigned';
          const vendorTotal = vendorTotals.get(vendorKey) || {
            vendorId: vendor?._id || null,
            vendorName: vendor?.name || 'Unassigned vendor',
            totalPurchaseValue: 0,
            receiptCount: 0
          };
          vendorTotal.totalPurchaseValue += movement.totalValue;
          vendorTotal.receiptCount += 1;
          vendorTotals.set(vendorKey, vendorTotal);
        } else if (['issue', 'department_issue', 'recipe_consumption'].includes(movement.movementType)) {
          totals.consumedQuantity += movement.quantity;
          totals.consumptionCost += movement.totalValue;
          monthTotal.consumptionCost += movement.totalValue;
        } else if (['wastage', 'expiry'].includes(movement.movementType)) {
          totals.wastedQuantity += movement.quantity;
          totals.wastageCost += movement.totalValue;
          monthTotal.wastageCost += movement.totalValue;
        }
        monthlyTotals.set(monthKey, monthTotal);
      }
      const purchases = movements.filter((movement) => movement.movementType === 'receipt')
        .reduce((sum, movement) => sum + movement.totalValue, 0);
      const consumption = movements.filter((movement) => (
        ['issue', 'department_issue', 'recipe_consumption'].includes(movement.movementType)
      )).reduce((sum, movement) => sum + movement.totalValue, 0);
      const wastage = movements.filter((movement) => (
        ['wastage', 'expiry'].includes(movement.movementType)
      )).reduce((sum, movement) => sum + movement.totalValue, 0);
      const stockAdjustment = movements.filter((movement) => (
        ['adjustment', 'physical_count'].includes(movement.movementType)
      )).reduce((sum, movement) => (
        sum + (movement.newStock < movement.previousStock ? -movement.totalValue : movement.totalValue)
      ), 0);
      const batchByItem = new Map(batchValues.map((batch) => [String(batch._id), batch]));
      let closingInventoryValue = items.reduce((sum, item) => {
        const batch = batchByItem.get(String(item._id));
        const batchQuantity = batch?.quantity || 0;
        const unbatchedQuantity = Math.max(0, item.currentStock - batchQuantity);
        return sum + (batch?.value || 0) + unbatchedQuantity * item.unitCost;
      }, 0);
      if (to && createdAt?.$lte) {
        const asOf = createdAt.$lte;
        const [batches, laterMovements] = await Promise.all([
          InventoryBatch.find({
            ...scope,
            itemId: { $in: items.map((item) => item._id) },
            receivedAt: { $lte: asOf }
          }).select('itemId quantity remainingQuantity unitCost').lean(),
          StockMovement.find({
            ...scope,
            itemId: { $in: items.map((item) => item._id) },
            $or: [
              { transactionDate: { $gt: asOf } },
              { transactionDate: { $exists: false }, createdAt: { $gt: asOf } }
            ]
          }).select('itemId previousStock newStock batchAllocations').lean()
        ]);
        const laterBatchReductions = new Map();
        const laterStockChanges = new Map();
        for (const movement of laterMovements) {
          const itemKey = String(movement.itemId);
          laterStockChanges.set(
            itemKey,
            (laterStockChanges.get(itemKey) || 0) + movement.newStock - movement.previousStock
          );
          for (const allocation of movement.batchAllocations || []) {
            if (!allocation.batchId) continue;
            const batchKey = String(allocation.batchId);
            laterBatchReductions.set(batchKey, (laterBatchReductions.get(batchKey) || 0) + allocation.quantity);
          }
        }
        const historicalBatchQuantity = new Map();
        const historicalBatchValues = new Map();
        for (const batch of batches) {
          const quantity = Math.min(
            batch.quantity,
            batch.remainingQuantity + (laterBatchReductions.get(String(batch._id)) || 0)
          );
          historicalBatchQuantity.set(
            String(batch.itemId),
            (historicalBatchQuantity.get(String(batch.itemId)) || 0) + quantity
          );
          historicalBatchValues.set(
            String(batch.itemId),
            (historicalBatchValues.get(String(batch.itemId)) || 0) + quantity * batch.unitCost
          );
        }
        closingInventoryValue = items.reduce((sum, item) => {
          const key = String(item._id);
          const historicalStock = Math.max(0, item.currentStock - (laterStockChanges.get(key) || 0));
          const batchedStock = historicalBatchQuantity.get(key) || 0;
          const unbatchedStock = Math.max(0, historicalStock - batchedStock);
          const batchedValue = historicalBatchValues.get(key) || 0;
          return sum + batchedValue + unbatchedStock * item.unitCost;
        }, 0);
      }
      closingInventoryValue = Math.round(closingInventoryValue * 100) / 100;
      return res.json({
        success: true,
        data: [{
          totalPurchaseValue: Math.round(purchases * 100) / 100,
          totalConsumptionCost: Math.round(consumption * 100) / 100,
          totalWastageLoss: Math.round(wastage * 100) / 100,
          closingInventoryValue,
          stockAdjustmentValue: Math.round(stockAdjustment * 100) / 100,
          totalRawMaterialCost: Math.round((consumption + wastage) * 100) / 100,
          vendorBreakdown: [...vendorTotals.values()].map((vendor) => ({
            ...vendor,
            totalPurchaseValue: Math.round(vendor.totalPurchaseValue * 100) / 100
          })).sort((a, b) => b.totalPurchaseValue - a.totalPurchaseValue),
          itemBreakdown: [...itemTotals.values()].map((item) => ({
            ...item,
            purchaseValue: Math.round(item.purchaseValue * 100) / 100,
            consumptionCost: Math.round(item.consumptionCost * 100) / 100,
            wastageCost: Math.round(item.wastageCost * 100) / 100
          })).sort((a, b) => (b.purchaseValue + b.consumptionCost + b.wastageCost)
            - (a.purchaseValue + a.consumptionCost + a.wastageCost)),
          monthlyTrend: [...monthlyTotals.values()].map((month) => ({
            ...month,
            purchaseValue: Math.round(month.purchaseValue * 100) / 100,
            consumptionCost: Math.round(month.consumptionCost * 100) / 100,
            wastageCost: Math.round(month.wastageCost * 100) / 100
          })).sort((a, b) => a.month.localeCompare(b.month))
        }]
      });
    }
    if (type === 'stock' || type === 'valuation') {
      const filter = {
        ...scope,
        ...(category && category !== 'all' ? { category } : {}),
        ...(itemId ? { _id: itemId } : {})
      };
      const items = await InventoryItem.find(filter).populate('vendorId', 'name').sort({ name: 1 }).lean();
      const expiredBatches = await InventoryBatch.aggregate([
        { $match: { ...scope, itemId: { $in: items.map((item) => item._id) }, expiryDate: { $lte: new Date() }, remainingQuantity: { $gt: 0 } } },
        { $group: { _id: '$itemId', quantity: { $sum: '$remainingQuantity' } } }
      ]);
      const expired = new Map(expiredBatches.map((batch) => [String(batch._id), batch.quantity]));
      const batchValues = type === 'valuation'
        ? await InventoryBatch.aggregate([
          { $match: { ...scope, itemId: { $in: items.map((item) => item._id) }, remainingQuantity: { $gt: 0 } } },
          { $group: {
            _id: '$itemId',
            quantity: { $sum: '$remainingQuantity' },
            value: { $sum: { $multiply: ['$remainingQuantity', '$unitCost'] } }
          } }
        ])
        : [];
      const valueByItem = new Map(batchValues.map((batch) => [String(batch._id), batch]));
      const data = items.map((item) => {
        const row = {
          ...item,
          availableStock: Math.max(0, item.currentStock - (expired.get(String(item._id)) || 0))
        };
        if (type === 'valuation') {
          const batch = valueByItem.get(String(item._id));
          const unbatchedQuantity = Math.max(0, item.currentStock - (batch?.quantity || 0));
          row.stockValue = (batch?.value || 0) + unbatchedQuantity * item.unitCost;
        }
        return row;
      });
      return res.json({
        success: true,
        data
      });
    }
    if (type === 'purchases') {
      const [receipts, legacyPurchaseOrders] = await Promise.all([
        GoodsReceipt.find({
          ...scope,
          ...(createdAt ? { receivedAt: createdAt } : {}),
          ...(itemId ? { 'lines.itemId': itemId } : {})
        })
          .populate({ path: 'purchaseOrderId', populate: { path: 'vendorId', select: 'name' } })
          .populate('lines.itemId', 'name code unit baseUnit')
          .sort({ receivedAt: -1 })
          .lean(),
        PurchaseOrder.find({
          ...scope,
          status: { $in: ['received', 'partially_received'] },
          ...(createdAt ? {
            $or: [
              { receivedDate: createdAt },
              { receivedDate: { $exists: false }, updatedAt: createdAt }
            ]
          } : {}),
          ...(itemId ? { 'items.itemId': itemId } : {})
        })
          .populate('vendorId', 'name')
          .populate('items.itemId', 'name code unit baseUnit')
          .sort({ receivedDate: -1, updatedAt: -1 })
          .lean()
      ]);
      const historicalReceiptOrderIds = legacyPurchaseOrders.length
        ? await GoodsReceipt.distinct('purchaseOrderId', {
          ...scope,
          purchaseOrderId: { $in: legacyPurchaseOrders.map((purchaseOrder) => purchaseOrder._id) }
        })
        : [];
      const receiptPurchaseOrderIds = new Set([
        ...receipts.map((receipt) => String(receipt.purchaseOrderId?._id || receipt.purchaseOrderId)),
        ...historicalReceiptOrderIds.map(String)
      ]);
      const legacyReceipts = legacyPurchaseOrders
        .filter((purchaseOrder) => !receiptPurchaseOrderIds.has(String(purchaseOrder._id)))
        .map((purchaseOrder) => ({
          _id: `legacy-${purchaseOrder._id}`,
          receiptNumber: '',
          receivedAt: purchaseOrder.receivedDate || purchaseOrder.updatedAt || purchaseOrder.createdAt,
          purchaseOrderId: purchaseOrder,
          lines: (purchaseOrder.items || [])
            .filter((line) => !itemId || String(line.itemId?._id || line.itemId) === String(itemId))
            .map((line) => ({
              itemId: line.itemId,
              receivedQuantity: Number(line.receivedQuantity) > 0
                ? Number(line.receivedQuantity)
                : purchaseOrder.status === 'received' ? Number(line.quantity) || 0 : 0,
              acceptedQuantity: Number(line.receivedQuantity) > 0
                ? Number(line.receivedQuantity)
                : purchaseOrder.status === 'received' ? Number(line.quantity) || 0 : 0,
              unit: line.unit || '',
              baseUnit: line.baseUnit || '',
              unitCost: Number(line.unitCost) || 0,
              taxInclusiveUnitCost: Number(line.unitCost) || 0,
              purchaseTaxAmount: 0
            }))
            .filter((line) => line.acceptedQuantity > 0)
        }))
        .filter((receipt) => receipt.lines.length > 0);
      const data = [...receipts, ...legacyReceipts]
        .sort((left, right) => new Date(right.receivedAt || 0) - new Date(left.receivedAt || 0));
      return res.json({ success: true, data });
    }
    if (type === 'recipe-consumption') {
      const filter = { ...scope, ...(createdAt ? { createdAt } : {}) };
      const data = await RecipeConsumption.find(filter).populate('ingredients.itemId', 'name code unit').sort({ createdAt: -1 }).lean();
      return res.json({ success: true, data });
    }
    if (type === 'recipe-usage' || type === 'recipe-monthly-usage') {
      const filter = {
        ...scope,
        status: 'deducted',
        ...(createdAt ? { deductedAt: createdAt } : {}),
        ...(itemId ? { 'ingredients.itemId': itemId } : {})
      };
      const consumptions = await RecipeConsumption.find(filter)
        .populate('ingredients.itemId', 'name code unit baseUnit')
        .sort({ deductedAt: -1 })
        .limit(5010)
        .lean();
      const grouped = new Map();
      const groupByMonth = type === 'recipe-monthly-usage';
      for (const consumption of consumptions) {
        const date = new Date(consumption.deductedAt).toISOString().slice(0, 10);
        for (const ingredient of consumption.ingredients) {
          const item = ingredient.itemId;
          if (!item || (itemId && String(item._id) !== String(itemId))) continue;
          const period = groupByMonth ? date.slice(0, 7) : date;
          const key = `${period}:${item._id}:${ingredient.menuItemId}`;
          const entry = grouped.get(key) || {
            ...(groupByMonth ? {} : { date }),
            month: date.slice(0, 7),
            itemId: String(item._id),
            itemName: item.name,
            code: item.code,
            unit: ingredient.baseUnit || item.baseUnit || item.unit,
            menuItemId: String(ingredient.menuItemId),
            menuItemName: ingredient.menuItemName,
            quantity: 0,
            totalCost: 0,
            orderIds: new Set()
          };
          entry.quantity += ingredient.quantity;
          entry.totalCost += ingredient.totalCost;
          entry.orderIds.add(String(consumption.orderId));
          grouped.set(key, entry);
        }
      }
      const data = [...grouped.values()].map(({ orderIds, ...entry }) => ({
        ...entry,
        quantity: Math.round(entry.quantity * 100000000) / 100000000,
        totalCost: Math.round(entry.totalCost * 100) / 100,
        orderCount: orderIds.size
      }));
      return res.json({ success: true, data });
    }
    if (type === 'verifications') {
      const filter = { ...scope, ...(createdAt ? { verifiedAt: createdAt } : {}) };
      if (itemId) filter.itemId = itemId;
      const data = await StockVerification.find(filter)
        .populate('itemId', 'name code unit baseUnit')
        .populate('verifiedBy', 'name')
        .sort({ verifiedAt: -1 })
        .limit(5010)
        .lean();
      return res.json({ success: true, data });
    }
    if (type === 'expiry') {
      const pipeline = [
        { $match: { ...scope } },
        { $unwind: '$lines' },
        { $match: { 'lines.expiryDate': { $ne: null }, ...(createdAt ? { 'lines.expiryDate': createdAt } : {}) } },
        { $lookup: { from: 'inventoryitems', localField: 'lines.itemId', foreignField: '_id', as: 'item' } },
        { $unwind: '$item' },
        ...(category && category !== 'all' ? [{ $match: { 'item.category': category } }] : []),
        { $project: {
          _id: 0,
          itemId: '$item._id',
          itemName: '$item.name',
          code: '$item.code',
          unit: '$item.unit',
          batchNumber: '$lines.batchNumber',
          expiryDate: '$lines.expiryDate',
          quantity: '$lines.acceptedQuantity',
          receiptNumber: 1,
          receivedAt: 1
        } },
        { $sort: { expiryDate: 1 } },
        { $limit: 5010 }
      ];
      const data = await GoodsReceipt.aggregate(pipeline);
      return res.json({ success: true, data });
    }
    const movementTypes = type === 'wastage' ? ['wastage', 'expiry']
      : type === 'department-consumption' ? ['issue', 'department_issue', 'recipe_consumption']
        : null;
    if (movementTypes) {
      const filter = {
        ...scope,
        movementType: { $in: movementTypes },
        ...(createdAt ? { createdAt } : {}),
        ...(department ? { department } : {}),
        ...(itemId ? { itemId } : {})
      };
      const data = await StockMovement.find(filter).populate('itemId', 'name code unit').populate('recordedBy', 'name')
        .sort({ createdAt: -1 }).limit(5010).lean();
      return res.json({ success: true, data });
    }
    if (type === 'ledger' || type === 'transfers' || type === 'adjustments') {
      const types = type === 'transfers' ? ['transfer']
        : type === 'adjustments' ? ['adjustment', 'physical_count']
          : null;
      const filter = {
        ...scope,
        ...(types ? { movementType: { $in: types } } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(department ? { department } : {}),
        ...(itemId ? { itemId } : {})
      };
      const data = await StockMovement.find(filter).populate('itemId', 'name code unit')
        .populate('recordedBy', 'name').sort({ createdAt: -1 }).limit(5010).lean();
      return res.json({ success: true, data });
    }
    res.status(400).json({ success: false, message: 'Unsupported inventory report type.' });
  } catch (err) {
    next(err);
  }
};

export const exportInventoryReport = async (req, res, next) => {
  try {
    const { type = 'stock', ...filters } = req.query;
    const request = { ...req, query: { ...filters, type } };
    const result = await new Promise((resolve, reject) => {
      getInventoryReport(request, {
        json: (body) => resolve(body),
        status: (status) => ({ json: (body) => resolve({ ...body, status }) })
      }, reject);
    });
    if (result.status && result.status !== 200) {
      return res.status(result.status).json(result);
    }
    const rows = result.data || [];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== '__v')))];
    const csvValue = (value) => {
      const text = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csv = [columns.map(csvValue).join(','), ...rows.map((row) => columns.map((key) => csvValue(row[key])).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-${type}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};
