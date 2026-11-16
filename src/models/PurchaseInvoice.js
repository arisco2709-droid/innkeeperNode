import mongoose from 'mongoose';

const invoiceLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  itemName: { type: String, required: true, trim: true },
  goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceipt', required: true },
  quantity: { type: Number, required: true, min: 0.00000001 },
  unit: { type: String, required: true, trim: true },
  unitPrice: { type: Number, required: true, min: 0 },
  discountAmount: { type: Number, min: 0, default: 0 },
  gstRate: { type: Number, min: 0, max: 100, default: 0 },
  cgstRate: { type: Number, min: 0, max: 100, default: 0 },
  sgstRate: { type: Number, min: 0, max: 100, default: 0 },
  igstRate: { type: Number, min: 0, max: 100, default: 0 },
  taxableAmount: { type: Number, min: 0, required: true },
  taxAmount: { type: Number, min: 0, default: 0 },
  cgstAmount: { type: Number, min: 0, default: 0 },
  sgstAmount: { type: Number, min: 0, default: 0 },
  igstAmount: { type: Number, min: 0, default: 0 },
  totalAmount: { type: Number, min: 0, required: true }
}, { _id: true });

const purchaseInvoiceSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  internalInvoiceId: { type: String, required: true },
  supplierInvoiceNumber: { type: String, required: true, trim: true },
  invoiceDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true, index: true },
  goodsReceiptIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceipt', required: true }],
  invoiceType: {
    type: String,
    enum: ['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note'],
    default: 'tax_invoice'
  },
  taxMode: { type: String, enum: ['legacy', 'intra_state', 'inter_state'], default: 'legacy' },
  supplierGSTIN: { type: String, trim: true, default: '' },
  hotelGSTIN: { type: String, trim: true, default: '' },
  placeOfSupply: { type: String, trim: true, default: '' },
  paymentTerms: { type: String, trim: true, default: '' },
  attachment: { type: String, trim: true, default: '' },
  lines: { type: [invoiceLineSchema], required: true },
  subtotal: { type: Number, min: 0, required: true },
  discountTotal: { type: Number, min: 0, default: 0 },
  taxTotal: { type: Number, min: 0, default: 0 },
  cgstTotal: { type: Number, min: 0, default: 0 },
  sgstTotal: { type: Number, min: 0, default: 0 },
  igstTotal: { type: Number, min: 0, default: 0 },
  otherCharges: { type: Number, min: 0, default: 0 },
  roundOff: { type: Number, default: 0 },
  grandTotal: { type: Number, min: 0, required: true },
  amountPaid: { type: Number, min: 0, default: 0 },
  creditAdjusted: { type: Number, min: 0, default: 0 },
  status: {
    type: String,
    enum: ['draft', 'pending_verification', 'verified', 'approved', 'partially_paid', 'paid', 'overdue', 'disputed', 'cancelled'],
    default: 'pending_verification',
    index: true
  },
  quantityVariance: { type: Boolean, default: false },
  priceVariance: { type: Boolean, default: false },
  verificationNotes: { type: String, trim: true, default: '' },
  enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  verifiedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: { type: Date, default: null },
  idempotencyKey: { type: String, default: undefined }
}, { timestamps: true });

purchaseInvoiceSchema.index({ hotelId: 1, propertyId: 1, internalInvoiceId: 1 }, { unique: true });
purchaseInvoiceSchema.index(
  { hotelId: 1, propertyId: 1, vendorId: 1, supplierInvoiceNumber: 1 },
  { unique: true, partialFilterExpression: { supplierInvoiceNumber: { $type: 'string' } } }
);
purchaseInvoiceSchema.index(
  { hotelId: 1, propertyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const PurchaseInvoice = mongoose.models.PurchaseInvoice
  || mongoose.model('PurchaseInvoice', purchaseInvoiceSchema);
