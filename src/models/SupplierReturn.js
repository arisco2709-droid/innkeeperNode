import mongoose from 'mongoose';

const supplierReturnLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  itemName: { type: String, required: true, trim: true },
  goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceipt', required: true },
  quantity: { type: Number, required: true, min: 0.00000001 },
  unit: { type: String, required: true, trim: true },
  conversionFactor: { type: Number, min: 0.00000001, default: 1 },
  unitValue: { type: Number, min: 0, default: 0 },
  stockDeducted: { type: Boolean, default: false }
}, { _id: true });

const supplierReturnSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  returnNumber: { type: String, required: true },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
  goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceipt', required: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseInvoice', default: null },
  reason: { type: String, required: true, trim: true },
  notes: { type: String, trim: true, default: '' },
  lines: { type: [supplierReturnLineSchema], required: true },
  totalValue: { type: Number, min: 0, required: true },
  creditNoteNumber: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['requested', 'approved', 'completed', 'rejected', 'cancelled'], default: 'requested', index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: { type: Date, default: null },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  completedAt: { type: Date, default: null },
  idempotencyKey: { type: String, default: undefined }
}, { timestamps: true });

supplierReturnSchema.index({ hotelId: 1, propertyId: 1, returnNumber: 1 }, { unique: true });
supplierReturnSchema.index(
  { hotelId: 1, propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const SupplierReturn = mongoose.models.SupplierReturn
  || mongoose.model('SupplierReturn', supplierReturnSchema);
