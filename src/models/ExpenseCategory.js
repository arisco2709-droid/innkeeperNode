import mongoose from 'mongoose';

const expenseCategorySchema = new mongoose.Schema({
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
  nameKey: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  code: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

expenseCategorySchema.pre('validate', function normalizeName() {
  if (this.name) this.nameKey = this.name.trim().toLocaleLowerCase();
});

expenseCategorySchema.index({ hotelId: 1, nameKey: 1 }, { unique: true });
expenseCategorySchema.index({ hotelId: 1, code: 1 }, { unique: true });
expenseCategorySchema.index({ hotelId: 1, isActive: 1, name: 1 });

export const ExpenseCategory = mongoose.models.ExpenseCategory
  || mongoose.model('ExpenseCategory', expenseCategorySchema);
