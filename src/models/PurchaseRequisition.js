import mongoose from 'mongoose';

const requisitionLineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true },
  itemName: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 0.00000001 },
  unit: { type: String, required: true, trim: true },
  availableQuantity: { type: Number, min: 0, default: 0 },
  approvedQuantity: { type: Number, min: 0, default: null }
}, { _id: true });

const purchaseRequisitionSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true, index: true },
  requisitionNumber: { type: String, required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  department: { type: String, required: true, trim: true },
  requiredLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorageLocation', required: true },
  requiredLocation: { type: String, required: true, trim: true },
  requiredDate: { type: Date, default: null },
  priority: { type: String, enum: ['normal', 'urgent'], default: 'normal' },
  reason: { type: String, trim: true, default: '' },
  remarks: { type: String, trim: true, default: '' },
  lines: { type: [requisitionLineSchema], required: true },
  status: {
    type: String,
    enum: ['pending', 'partially_approved', 'approved', 'rejected', 'ordered', 'cancelled'],
    default: 'pending',
    index: true
  },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNotes: { type: String, trim: true, default: '' },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null }
}, { timestamps: true });

purchaseRequisitionSchema.index({ hotelId: 1, propertyId: 1, requisitionNumber: 1 }, { unique: true });

export const PurchaseRequisition = mongoose.models.PurchaseRequisition
  || mongoose.model('PurchaseRequisition', purchaseRequisitionSchema);
