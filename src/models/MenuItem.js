import mongoose from 'mongoose';

const menuItemSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MenuCategory',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  acPricingEnabled: {
    type: Boolean,
    default: false
  },
  acPrice: {
    type: Number,
    min: 0,
    default: null
  },
  nonAcPricingEnabled: {
    type: Boolean,
    default: true
  },
  nonAcPrice: {
    type: Number,
    min: 0,
    default: null
  },
  taxPercent: {
    type: Number,
    default: 5
  },
  discountType: {
    type: String,
    enum: ['none', 'percentage', 'flat'],
    default: 'none'
  },
  discountValue: {
    type: Number,
    min: 0,
    default: 0
  },
  isAvailable: {
    type: Boolean,
    default: true
  },
  image: {
    type: String,
    default: ''
  },
  preparationTimeMinutes: {
    type: Number,
    default: 15
  }
}, {
  timestamps: true
});

export const MenuItem = mongoose.models.MenuItem || mongoose.model('MenuItem', menuItemSchema);
