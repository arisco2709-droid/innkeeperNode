import mongoose from 'mongoose';

const storageLocationTypeSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    enum: [
      'main_store',
      'restaurant_store',
      'kitchen_store',
      'cold_storage',
      'freezer_storage',
      'beverage_store',
      'dry_store',
      'housekeeping_store'
    ],
    unique: true,
    immutable: true
  },
  name: { type: String, required: true, unique: true, immutable: true },
  isSystem: { type: Boolean, default: true, immutable: true }
}, { timestamps: true });

export const StorageLocationType = mongoose.models.StorageLocationType
  || mongoose.model('StorageLocationType', storageLocationTypeSchema);
