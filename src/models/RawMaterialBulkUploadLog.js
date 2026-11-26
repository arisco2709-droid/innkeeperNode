import mongoose from 'mongoose';

export const RAW_MATERIAL_BULK_UPLOAD_STATUSES = [
  'Processing',
  'Success',
  'Partially Success',
  'Failed'
];

const rowResultSchema = new mongoose.Schema({
  rowNumber: { type: Number, required: true },
  materialName: { type: String, default: '' },
  status: { type: String, enum: ['Success', 'Failed', 'Duplicate'], required: true },
  messages: { type: [String], default: [] }
}, { _id: false });

const rawMaterialBulkUploadLogSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  propertyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property',
    required: true,
    index: true
  },
  fileName: { type: String, default: '' },
  originalFilePath: { type: String, default: '' },
  failedFilePath: { type: String, default: '' },
  totalRows: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
  duplicateCount: { type: Number, default: 0 },
  uploadStatus: {
    type: String,
    enum: RAW_MATERIAL_BULK_UPLOAD_STATUSES,
    default: 'Processing',
    index: true
  },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  uploadedByName: { type: String, default: '' },
  remarks: { type: String, default: '' },
  rowResults: { type: [rowResultSchema], default: [] }
}, { timestamps: true });

rawMaterialBulkUploadLogSchema.index({ hotelId: 1, propertyId: 1, createdAt: -1 });

export const RawMaterialBulkUploadLog = mongoose.models.RawMaterialBulkUploadLog
  || mongoose.model('RawMaterialBulkUploadLog', rawMaterialBulkUploadLogSchema);
