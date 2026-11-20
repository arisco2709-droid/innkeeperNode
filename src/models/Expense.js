import mongoose from 'mongoose';

export const LEGACY_EXPENSE_CATEGORIES = [
  'salaries',
  'electricity',
  'water',
  'internet',
  'repairs',
  'supplies',
  'food_beverage',
  'vendor_payment',
  'marketing',
  'miscellaneous'
];

export const LEGACY_EXPENSE_CATEGORY_LABELS = {
  salaries: 'Salaries',
  electricity: 'Electricity',
  water: 'Water',
  internet: 'Internet',
  repairs: 'Repairs',
  supplies: 'Supplies',
  food_beverage: 'Food Beverage',
  vendor_payment: 'Vendor Payment',
  marketing: 'Marketing',
  miscellaneous: 'Miscellaneous'
};

const expenseSchema = new mongoose.Schema({
  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true
  },
  propertyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property',
    default: null
  },
  expenseNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // Legacy enum slug OR custom ExpenseCategory code/name
  category: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0.01
  },
  date: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vendor'
  },
  vendorName: String,
  description: {
    type: String,
    required: true
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank_transfer', 'credit_card', 'cheque', 'upi', 'other'],
    default: 'bank_transfer'
  },
  receiptUrl: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  rejectionReason: {
    type: String,
    default: ''
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

export const Expense = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
