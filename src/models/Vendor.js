import mongoose from 'mongoose';

const vendorSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  contactPerson: {
    type: String,
    default: ''
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    default: ''
  },
  phone: {
    type: String,
    required: true
  },
  address: {
    type: String,
    default: ''
  },
  taxNumber: {
    type: String,
    default: ''
  },
  panNumber: { type: String, trim: true, default: '' },
  state: { type: String, trim: true, default: '' },
  stateCode: { type: String, trim: true, default: '' },
  supplierCategory: { type: String, trim: true, default: '' },
  creditPeriodDays: { type: Number, min: 0, default: 30 },
  openingBalance: { type: Number, min: 0, default: 0 },
  bankDetails: {
    accountName: { type: String, trim: true, default: '' },
    accountNumber: { type: String, trim: true, default: '' },
    ifsc: { type: String, trim: true, default: '' },
    bankName: { type: String, trim: true, default: '' },
    upiId: { type: String, trim: true, default: '' }
  },
  supplierCode: { type: String, trim: true, default: '' },
  paymentTerms: {
    type: String,
    default: 'Net 30'
  },
  outstandingBalance: { type: Number, min: 0, default: 0 },
  suppliedItems: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem' }],
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  }
}, {
  timestamps: true
});

vendorSchema.index(
  { hotelId: 1, taxNumber: 1 },
  { unique: true, partialFilterExpression: { taxNumber: { $type: 'string', $gt: '' } } }
);

export const Vendor = mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema);
