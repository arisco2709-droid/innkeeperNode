import mongoose from 'mongoose';

const storageLocationSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  locationName: { type: String, required: true, trim: true },
  normalizedName: { type: String, required: true, trim: true, lowercase: true },
  locationTypeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StorageLocationType',
    required: true,
    index: true
  },
  description: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true, index: true },
  isLegacy: { type: Boolean, default: false }
}, { timestamps: true });

storageLocationSchema.index({ hotelId: 1, normalizedName: 1 }, { unique: true });
storageLocationSchema.index({ hotelId: 1, locationTypeId: 1, isActive: 1, locationName: 1 });

export const StorageLocation = mongoose.models.StorageLocation
  || mongoose.model('StorageLocation', storageLocationSchema);
