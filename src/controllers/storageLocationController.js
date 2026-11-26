import mongoose from 'mongoose';
import { InventoryBatch } from '../models/InventoryBatch.js';
import { InventoryBalance } from '../models/InventoryBalance.js';
import { StorageLocation } from '../models/StorageLocation.js';
import { StorageLocationType } from '../models/StorageLocationType.js';
import { logAudit } from '../services/auditService.js';
import {
  ensureLegacyStorageLocations,
  STORAGE_LOCATION_TYPES
} from '../services/storageLocationService.js';

const isAdmin = (req) => ['hotel_admin', 'super_admin'].includes(req.user?.role);

export const getStorageLocationTypes = async (req, res, next) => {
  try {
    const types = await ensureLegacyStorageLocations(req.hotelId);
    res.json({
      success: true,
      data: types.map((type) => ({
        _id: type._id,
        key: type.key,
        name: type.name
      }))
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'A storage location with this name already exists in this hotel.' });
    }
    next(error);
  }
};

export const getStorageLocations = async (req, res, next) => {
  try {
    if (req.query.includeInactive === 'true' && !isAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can view inactive storage locations.' });
    }
    await ensureLegacyStorageLocations(req.hotelId);
    const filter = { hotelId: req.hotelId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;
    if (req.query.typeId) {
      if (!mongoose.isValidObjectId(req.query.typeId)) {
        return res.status(400).json({ success: false, message: 'Choose a valid storage location type.' });
      }
      filter.locationTypeId = req.query.typeId;
    }
    if (req.query.search) {
      const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.locationName = { $regex: escaped, $options: 'i' };
    }
    const locations = await StorageLocation.find(filter)
      .populate('locationTypeId', 'key name')
      .sort({ isActive: -1, locationName: 1 })
      .lean();
    res.json({ success: true, data: locations });
  } catch (error) {
    next(error);
  }
};

export const createStorageLocation = async (req, res, next) => {
  try {
    const locationName = String(req.body.locationName || '').trim();
    const description = String(req.body.description || '').trim();
    const locationTypeId = req.body.locationTypeId;
    if (!locationName || locationName.length > 120) {
      return res.status(400).json({ success: false, message: 'Enter a storage location name (up to 120 characters).' });
    }
    if (!mongoose.isValidObjectId(locationTypeId)) {
      return res.status(400).json({ success: false, message: 'Choose one of the predefined storage location types.' });
    }
    if (description.length > 500) {
      return res.status(400).json({ success: false, message: 'Description cannot exceed 500 characters.' });
    }
    const type = await StorageLocationType.findOne({
      _id: locationTypeId,
      key: { $in: STORAGE_LOCATION_TYPES.map(({ key }) => key) }
    }).lean();
    if (!type) return res.status(400).json({ success: false, message: 'Choose one of the predefined storage location types.' });
    const location = await StorageLocation.create({
      hotelId: req.hotelId,
      locationName,
      normalizedName: locationName.toLocaleLowerCase(),
      locationTypeId: type._id,
      description,
      isActive: true
    });
    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_STORAGE_LOCATION',
      entity: 'StorageLocation',
      entityId: location._id,
      details: { locationName, locationType: type.name },
      req
    });
    await location.populate('locationTypeId', 'key name');
    res.status(201).json({ success: true, data: location });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'A storage location with this name already exists in this hotel.' });
    }
    next(error);
  }
};

export const updateStorageLocation = async (req, res, next) => {
  try {
    const location = await StorageLocation.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!location) return res.status(404).json({ success: false, message: 'Storage location not found.' });
    if (req.body.locationName !== undefined) {
      const locationName = String(req.body.locationName || '').trim();
      if (!locationName || locationName.length > 120) {
        return res.status(400).json({ success: false, message: 'Enter a storage location name (up to 120 characters).' });
      }
      location.locationName = locationName;
      location.normalizedName = locationName.toLocaleLowerCase();
    }
    if (req.body.locationTypeId !== undefined) {
      if (!mongoose.isValidObjectId(req.body.locationTypeId)) {
        return res.status(400).json({ success: false, message: 'Choose one of the predefined storage location types.' });
      }
      const type = await StorageLocationType.findOne({
        _id: req.body.locationTypeId,
        key: { $in: STORAGE_LOCATION_TYPES.map(({ key }) => key) }
      }).lean();
      if (!type) return res.status(400).json({ success: false, message: 'Choose one of the predefined storage location types.' });
      location.locationTypeId = type._id;
    }
    if (req.body.description !== undefined) {
      location.description = String(req.body.description || '').trim();
      if (location.description.length > 500) {
        return res.status(400).json({ success: false, message: 'Description cannot exceed 500 characters.' });
      }
    }
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({ success: false, message: 'Location status must be active or inactive.' });
      }
      if (!req.body.isActive) {
        const [hasBalance, hasBatch] = await Promise.all([
          InventoryBalance.exists({
            hotelId: req.hotelId, locationId: location._id, quantity: { $gt: 0 }
          }),
          InventoryBatch.exists({
            hotelId: req.hotelId, locationId: location._id, remainingQuantity: { $gt: 0 }
          })
        ]);
        if (hasBalance || hasBatch) {
          return res.status(409).json({
            success: false,
            message: 'This location still contains stock. Transfer or use the stock before deactivating it.'
          });
        }
      }
      location.isActive = req.body.isActive;
    }
    await location.save();
    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_STORAGE_LOCATION',
      entity: 'StorageLocation',
      entityId: location._id,
      details: { locationName: location.locationName, isActive: location.isActive },
      req
    });
    await location.populate('locationTypeId', 'key name');
    res.json({ success: true, data: location });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'A storage location with this name already exists in this hotel.' });
    }
    next(error);
  }
};

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const getStorageLocationStock = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Choose a valid storage location.' });
    }
    const location = await StorageLocation.findOne({ _id: req.params.id, hotelId: req.hotelId })
      .populate('locationTypeId', 'key name')
      .lean();
    if (!location) return res.status(404).json({ success: false, message: 'Storage location not found.' });

    const batchFilter = {
      hotelId: req.hotelId,
      $or: [
        { locationId: location._id },
        { locationId: null, location: location.locationName }
      ]
    };
    if (mongoose.isValidObjectId(req.propertyId)) batchFilter.propertyId = req.propertyId;
    const batches = await InventoryBatch.find(batchFilter)
      .populate('itemId', 'name code baseUnit unit')
      .lean();

    const itemsById = new Map();
    for (const batch of batches) {
      const item = batch.itemId;
      if (!item?._id) continue;
      const key = String(item._id);
      const entry = itemsById.get(key) || {
        itemId: item._id,
        itemName: item.name,
        itemCode: item.code || '',
        unit: item.baseUnit || item.unit || '',
        receivedQuantity: 0,
        currentQuantity: 0,
        receivedValue: 0,
        currentValue: 0,
        purchaseValue: 0,
        batchCount: 0
      };
      const receivedQuantity = Number(batch.quantity) || 0;
      const currentQuantity = Number(batch.remainingQuantity) || 0;
      const unitCost = Number(batch.unitCost) || 0;
      const purchaseAmount = Number(batch.purchaseAmount);
      entry.receivedQuantity += receivedQuantity;
      entry.currentQuantity += currentQuantity;
      entry.receivedValue += receivedQuantity * unitCost;
      entry.currentValue += currentQuantity * unitCost;
      entry.purchaseValue += Number.isFinite(purchaseAmount) && purchaseAmount >= 0
        ? purchaseAmount
        : receivedQuantity * unitCost;
      entry.batchCount += 1;
      itemsById.set(key, entry);
    }

    const items = [...itemsById.values()]
      .map((entry) => ({
        itemId: entry.itemId,
        itemName: entry.itemName,
        itemCode: entry.itemCode,
        unit: entry.unit,
        receivedQuantity: entry.receivedQuantity,
        usedQuantity: Math.max(0, entry.receivedQuantity - entry.currentQuantity),
        currentQuantity: entry.currentQuantity,
        averageUnitCost: entry.receivedQuantity > 0
          ? roundMoney(entry.receivedValue / entry.receivedQuantity)
          : 0,
        currentValue: roundMoney(entry.currentValue),
        purchaseValue: roundMoney(entry.purchaseValue),
        batchCount: entry.batchCount
      }))
      .sort((left, right) => left.itemName.localeCompare(right.itemName));

    res.json({
      success: true,
      data: {
        locationId: location._id,
        locationName: location.locationName,
        locationType: location.locationTypeId?.name || '',
        items,
        currentValue: roundMoney(items.reduce((total, item) => total + item.currentValue, 0))
      }
    });
  } catch (error) {
    next(error);
  }
};
