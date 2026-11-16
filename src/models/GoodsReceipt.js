import mongoose from 'mongoose';

const goodsReceiptLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  receivedQuantity: { type: Number, required: true, min: 0 },
  acceptedQuantity: { type: Number, required: true, min: 0 },
  damagedQuantity: { type: Number, required: true, min: 0, default: 0 },
  rejectedQuantity: { type: Number, required: true, min: 0, default: 0 },
  inspectionPendingQuantity: { type: Number, min: 0, default: 0 },
  unit: { type: String, trim: true, default: '' },
  unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  purchasePackageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  packageNameSnapshot: { type: String, trim: true, default: '' },
  unitNameSnapshot: { type: String, trim: true, default: '' },
  unitSymbolSnapshot: { type: String, trim: true, default: '' },
  conversionFactor: { type: Number, min: 0, default: 1 },
  baseUnit: { type: String, trim: true, default: '' },
  baseUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', default: null },
  baseUnitNameSnapshot: { type: String, trim: true, default: '' },
  baseUnitSymbolSnapshot: { type: String, trim: true, default: '' },
  batchNumber: { type: String, trim: true, default: '' },
  expiryDate: { type: Date, default: null },
  unitCost: { type: Number, required: true, min: 0 },
  purchaseTaxAmount: { type: Number, min: 0, default: 0 },
  taxInclusiveUnitCost: { type: Number, min: 0, default: null }
}, { _id: false });

const goodsReceiptSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true, index: true },
  receiptNumber: { type: String, required: true },
  requestKey: { type: String, default: undefined },
  invoiceNumber: { type: String, trim: true, default: '' },
  invoiceAttachment: { type: String, default: '' },
  location: { type: String, trim: true, default: 'Main Store' },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorageLocation', default: null, index: true },
  lines: { type: [goodsReceiptLineSchema], required: true },
  purchaseTaxAmount: { type: Number, min: 0, default: 0 },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receivedAt: { type: Date, default: Date.now },
  notes: { type: String, trim: true, default: '' },
  inspectionStatus: {
    type: String,
    enum: ['not_required', 'pending', 'partially_inspected', 'completed'],
    default: 'not_required',
    index: true
  },
  supplierChallanNumber: { type: String, trim: true, default: '' },
  vehicleNumber: { type: String, trim: true, default: '' },
  inspection: {
    materialCondition: { type: String, trim: true, default: '' },
    freshness: { type: String, trim: true, default: '' },
    packagingCondition: { type: String, trim: true, default: '' },
    temperatureCelsius: { type: Number, default: null },
    remarks: { type: String, trim: true, default: '' },
    inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    inspectedAt: { type: Date, default: null }
  }
}, { timestamps: true });

goodsReceiptSchema.index({ hotelId: 1, propertyId: 1, receiptNumber: 1 }, { unique: true });
goodsReceiptSchema.index(
  { hotelId: 1, propertyId: 1, requestKey: 1 },
  { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } }
);

export const GoodsReceipt = mongoose.models.GoodsReceipt || mongoose.model('GoodsReceipt', goodsReceiptSchema);
