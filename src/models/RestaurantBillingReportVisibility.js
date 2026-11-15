import mongoose from 'mongoose';

const restoreRequestSchema = new mongoose.Schema({
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestedAt: { type: Date, default: Date.now },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, trim: true, maxlength: 500, default: '' }
}, { timestamps: false });

const restaurantBillingReportVisibilitySchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true },
  propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
  reportDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  isHidden: { type: Boolean, default: true },
  hiddenAt: { type: Date, default: Date.now },
  hiddenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  restoreRequests: { type: [restoreRequestSchema], default: [] }
}, { timestamps: true });

restaurantBillingReportVisibilitySchema.index(
  { hotelId: 1, propertyId: 1, reportDate: 1 },
  { unique: true }
);
restaurantBillingReportVisibilitySchema.index({ hotelId: 1, propertyId: 1, isHidden: 1, reportDate: -1 });

export const RestaurantBillingReportVisibility = mongoose.models.RestaurantBillingReportVisibility
  || mongoose.model('RestaurantBillingReportVisibility', restaurantBillingReportVisibilitySchema);
