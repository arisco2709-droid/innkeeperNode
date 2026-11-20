import dayjs from 'dayjs';
import mongoose from 'mongoose';
import {
  Expense,
  ExpenseCategory
} from '../models/index.js';
import {
  LEGACY_EXPENSE_CATEGORIES,
  LEGACY_EXPENSE_CATEGORY_LABELS
} from '../models/Expense.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { notifyHotelOperations } from '../services/notificationService.js';

const sendError = (res, status, message) => res.status(status).json({ success: false, message });
const normalize = (value) => String(value || '').trim();
const slugify = (value) => normalize(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  || 'category';

const hotelFilterFor = (req) => {
  if (req.user.role === 'super_admin' && !req.hotelId) return {};
  return { hotelId: req.hotelId };
};

const ensureDefaultCategories = async (hotelId, userId = null) => {
  if (!hotelId) return [];
  const existingCount = await ExpenseCategory.countDocuments({ hotelId });
  if (existingCount > 0) {
    return ExpenseCategory.find({ hotelId }).sort({ name: 1 });
  }

  const docs = LEGACY_EXPENSE_CATEGORIES.map((code) => ({
    hotelId,
    name: LEGACY_EXPENSE_CATEGORY_LABELS[code] || code,
    nameKey: (LEGACY_EXPENSE_CATEGORY_LABELS[code] || code).toLocaleLowerCase(),
    code,
    description: '',
    isActive: true,
    createdBy: userId || null,
    updatedBy: userId || null
  }));

  try {
    await ExpenseCategory.insertMany(docs, { ordered: false });
  } catch (err) {
    // Concurrent seed race — ignore duplicate key errors
    if (err?.code !== 11000 && !err?.writeErrors) throw err;
  }

  return ExpenseCategory.find({ hotelId }).sort({ name: 1 });
};

const resolveCategoryValue = async (hotelId, rawCategory) => {
  const value = normalize(rawCategory);
  if (!value) return { error: 'Category is required.' };

  const nameKey = value.toLocaleLowerCase();
  const code = slugify(value);

  const match = await ExpenseCategory.findOne({
    hotelId,
    isActive: true,
    $or: [
      { code },
      { nameKey },
      { name: value },
      { code: value.toLowerCase() }
    ]
  });

  if (match) {
    return { category: match.code, categoryDoc: match };
  }

  if (LEGACY_EXPENSE_CATEGORIES.includes(value.toLowerCase())) {
    return { category: value.toLowerCase() };
  }

  return { error: 'Choose an active expense category.' };
};

export const getExpenseCategories = async (req, res, next) => {
  try {
    if (!req.hotelId) {
      return sendError(res, 400, 'A hotel context is required to load expense categories.');
    }

    await ensureDefaultCategories(req.hotelId, req.user?._id);

    const filter = { hotelId: req.hotelId };
    if (req.query.includeInactive !== 'true') filter.isActive = true;

    const categories = await ExpenseCategory.find(filter).sort({ name: 1 });
    res.json({ success: true, data: categories });
  } catch (err) {
    next(err);
  }
};

export const createExpenseCategory = async (req, res, next) => {
  try {
    if (!req.hotelId) {
      return sendError(res, 400, 'A hotel context is required to create expense categories.');
    }
    if (req.user.role === 'super_admin') {
      return sendError(res, 403, 'Platform administrators cannot manage hotel expense categories.');
    }

    const name = normalize(req.body.name);
    if (!name) return sendError(res, 400, 'Category name is required.');

    const code = normalize(req.body.code) ? slugify(req.body.code) : slugify(name);
    const category = await ExpenseCategory.create({
      hotelId: req.hotelId,
      name,
      code,
      description: normalize(req.body.description),
      isActive: req.body.isActive !== false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_EXPENSE_CATEGORY',
      entity: 'ExpenseCategory',
      entityId: category._id,
      details: { name: category.name, code: category.code },
      req
    });

    res.status(201).json({ success: true, message: 'Expense category created.', data: category });
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 409, 'An expense category with this name already exists.');
    }
    next(err);
  }
};

export const updateExpenseCategory = async (req, res, next) => {
  try {
    if (!req.hotelId) {
      return sendError(res, 400, 'A hotel context is required to update expense categories.');
    }
    if (req.user.role === 'super_admin') {
      return sendError(res, 403, 'Platform administrators cannot manage hotel expense categories.');
    }

    const category = await ExpenseCategory.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!category) return sendError(res, 404, 'Expense category not found.');

    if (req.body.name !== undefined) {
      const name = normalize(req.body.name);
      if (!name) return sendError(res, 400, 'Category name is required.');
      category.name = name;
    }
    if (req.body.description !== undefined) category.description = normalize(req.body.description);
    if (req.body.isActive !== undefined) category.isActive = req.body.isActive === true || req.body.isActive === 'true';
    if (req.body.code !== undefined && normalize(req.body.code)) {
      category.code = slugify(req.body.code);
    }
    category.updatedBy = req.user._id;
    await category.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_EXPENSE_CATEGORY',
      entity: 'ExpenseCategory',
      entityId: category._id,
      details: { name: category.name, code: category.code, isActive: category.isActive },
      req
    });

    res.json({ success: true, message: 'Expense category updated.', data: category });
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 409, 'An expense category with this name already exists.');
    }
    next(err);
  }
};

export const getExpenses = async (req, res, next) => {
  try {
    const { category, status, startDate, endDate, page = 1, limit = 20 } = req.query;
    if (req.user.role === 'super_admin' && req.hotelId && !mongoose.Types.ObjectId.isValid(req.hotelId)) {
      return res.status(400).json({ success: false, message: 'A valid hotel ID is required.' });
    }
    const hotelFilter = hotelFilterFor(req);
    const filter = { ...hotelFilter };

    if (category && category !== 'all') filter.category = category;
    if (status && status !== 'all') filter.status = status;
    if (startDate && endDate) {
      filter.date = {
        $gte: dayjs(startDate).startOf('day').toDate(),
        $lte: dayjs(endDate).endOf('day').toDate()
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Expense.countDocuments(filter);
    const expenses = await Expense.find(filter)
      .populate('hotelId', 'name')
      .populate('vendorId', 'name')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ date: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Summary aggregation by category — approved only
    const categorySummary = await Expense.aggregate([
      { $match: { ...hotelFilter, status: 'approved' } },
      { $group: { _id: '$category', total: { $sum: '$amount' } } }
    ]);

    const monthStart = dayjs().startOf('month').toDate();
    const monthEnd = dayjs().endOf('month').toDate();
    const monthlySummary = await Expense.aggregate([
      { $match: { ...hotelFilter, status: 'approved', date: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: '$category', total: { $sum: '$amount' } } }
    ]);
    const monthlyTotal = monthlySummary.reduce((sum, row) => sum + row.total, 0);

    res.json({
      success: true,
      data: {
        expenses,
        categorySummary,
        monthlySummary,
        monthlyTotal,
        month: dayjs().format('YYYY-MM'),
        pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
      }
    });
  } catch (err) {
    next(err);
  }
};

export const createExpense = async (req, res, next) => {
  try {
    if (req.user.role === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Platform administrators can view expenses but cannot record hotel expenses.'
      });
    }
    const { category, amount, date, description, vendorId, paymentMethod, receiptUrl } = req.body;

    if (!normalize(description)) {
      return sendError(res, 400, 'Description is required.');
    }

    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum < 0.01) {
      return sendError(res, 400, 'Amount must be greater than zero.');
    }

    if (req.hotelId) {
      await ensureDefaultCategories(req.hotelId, req.user._id);
    }

    const resolved = await resolveCategoryValue(req.hotelId, category);
    if (resolved.error) return sendError(res, 400, resolved.error);

    const expense = await Expense.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      expenseNumber: generateReference('EXP'),
      category: resolved.category,
      amount: amountNum,
      date: date || new Date(),
      description: normalize(description),
      vendorId: vendorId || null,
      paymentMethod: paymentMethod || 'bank_transfer',
      receiptUrl: receiptUrl || '',
      status: 'pending',
      createdBy: req.user._id,
      approvedBy: null
    });

    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_EXPENSE',
      entity: 'Expense',
      entityId: expense._id,
      details: {
        expenseNumber: expense.expenseNumber,
        category: expense.category,
        amount: expense.amount,
        status: expense.status
      },
      req
    });

    await notifyHotelOperations({
      hotelId: req.hotelId,
      title: 'Expense recorded',
      message: `Expense ${expense.expenseNumber} for ${expense.amount} was recorded.`,
      module: 'expenses',
      eventType: 'expense_created',
      relatedRecordId: expense._id,
      link: '/expenses',
      eventId: `expense-created:${expense._id}`
    });

    res.status(201).json({
      success: true,
      message: 'Expense submitted for approval.',
      data: expense
    });
  } catch (err) {
    next(err);
  }
};

export const updateExpense = async (req, res, next) => {
  try {
    if (req.user.role === 'super_admin') {
      return sendError(res, 403, 'Platform administrators cannot edit hotel expenses.');
    }

    const expense = await Expense.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!expense) return sendError(res, 404, 'Expense not found.');

    if (['rejected', 'cancelled'].includes(expense.status)) {
      return sendError(res, 400, `Cannot edit a ${expense.status} expense.`);
    }

    const updates = {};
    if (req.body.amount !== undefined) {
      const amountNum = Number(req.body.amount);
      if (!Number.isFinite(amountNum) || amountNum < 0.01) {
        return sendError(res, 400, 'Amount must be greater than zero.');
      }
      updates.amount = amountNum;
    }
    if (req.body.description !== undefined) {
      const description = normalize(req.body.description);
      if (!description) return sendError(res, 400, 'Description is required.');
      updates.description = description;
    }
    if (req.body.date !== undefined) updates.date = req.body.date;
    if (req.body.paymentMethod !== undefined) updates.paymentMethod = req.body.paymentMethod;
    if (req.body.vendorId !== undefined) updates.vendorId = req.body.vendorId || null;

    if (req.body.category !== undefined) {
      const incoming = normalize(req.body.category);
      const sameAsCurrent =
        incoming === expense.category ||
        slugify(incoming) === expense.category ||
        incoming.toLocaleLowerCase() === expense.category.toLocaleLowerCase();
      if (!sameAsCurrent) {
        await ensureDefaultCategories(req.hotelId, req.user._id);
        const resolved = await resolveCategoryValue(req.hotelId, req.body.category);
        if (resolved.error) return sendError(res, 400, resolved.error);
        updates.category = resolved.category;
      }
    }

    Object.assign(expense, updates);
    await expense.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_EXPENSE',
      entity: 'Expense',
      entityId: expense._id,
      details: { expenseNumber: expense.expenseNumber, updates },
      req
    });

    res.json({ success: true, message: 'Expense updated.', data: expense });
  } catch (err) {
    next(err);
  }
};

export const updateExpenseStatus = async (req, res, next) => {
  try {
    const { status, reason, rejectionReason } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return sendError(res, 400, 'Status must be approved, rejected, or pending.');
    }

    const expense = await Expense.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!expense) return sendError(res, 404, 'Expense not found.');

    if (expense.status === 'cancelled') {
      return sendError(res, 400, 'Cannot change status of a cancelled expense.');
    }

    if (status === 'rejected') {
      const rejection = normalize(rejectionReason || reason);
      if (!rejection) {
        return sendError(res, 400, 'A rejection reason is required.');
      }
      expense.rejectionReason = rejection;
      expense.approvedBy = req.user._id;
    } else if (status === 'approved') {
      expense.approvedBy = req.user._id;
      expense.rejectionReason = '';
    } else {
      expense.approvedBy = null;
      expense.rejectionReason = '';
    }

    expense.status = status;
    await expense.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_EXPENSE_STATUS',
      entity: 'Expense',
      entityId: expense._id,
      details: {
        expenseNumber: expense.expenseNumber,
        status: expense.status,
        rejectionReason: expense.rejectionReason || undefined
      },
      req
    });

    await notifyHotelOperations({
      hotelId: req.hotelId,
      title: 'Expense status updated',
      message: `Expense ${expense.expenseNumber} is now ${expense.status}.`,
      module: 'expenses',
      eventType: 'expense_status_updated',
      relatedRecordId: expense._id,
      link: '/expenses',
      eventId: `expense-status:${expense._id}:${expense.updatedAt?.getTime?.() || Date.now()}`
    });
    res.json({ success: true, message: `Expense marked as ${status}.`, data: expense });
  } catch (err) {
    next(err);
  }
};

export const voidExpense = async (req, res, next) => {
  try {
    if (req.user.role === 'super_admin') {
      return sendError(res, 403, 'Platform administrators cannot void hotel expenses.');
    }

    const expense = await Expense.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!expense) return sendError(res, 404, 'Expense not found.');

    if (expense.status === 'cancelled') {
      return sendError(res, 400, 'Expense is already cancelled.');
    }

    const reason = normalize(req.body?.reason || req.body?.cancellationReason);
    expense.status = 'cancelled';
    if (reason) expense.rejectionReason = reason;
    await expense.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'VOID_EXPENSE',
      entity: 'Expense',
      entityId: expense._id,
      details: {
        expenseNumber: expense.expenseNumber,
        status: expense.status,
        reason: reason || undefined
      },
      req
    });

    res.json({ success: true, message: 'Expense cancelled.', data: expense });
  } catch (err) {
    next(err);
  }
};

export const uploadExpenseReceiptFile = async (req, res, next) => {
  try {
    if (req.user.role === 'super_admin') {
      return sendError(res, 403, 'Platform administrators cannot upload expense receipts.');
    }

    const expense = await Expense.findOne({ _id: req.params.id, hotelId: req.hotelId });
    if (!expense) return sendError(res, 404, 'Expense not found.');

    if (['rejected', 'cancelled'].includes(expense.status)) {
      return sendError(res, 400, `Cannot attach a receipt to a ${expense.status} expense.`);
    }

    const uploaded =
      req.file ||
      req.files?.receipt?.[0] ||
      req.files?.file?.[0] ||
      null;
    if (!uploaded) {
      return sendError(res, 400, 'Receipt file is required (field: receipt or file).');
    }

    const receiptUrl = `/uploads/expenses/${uploaded.filename}`;
    expense.receiptUrl = receiptUrl;
    await expense.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPLOAD_EXPENSE_RECEIPT',
      entity: 'Expense',
      entityId: expense._id,
      details: { expenseNumber: expense.expenseNumber, receiptUrl },
      req
    });

    res.json({
      success: true,
      message: 'Receipt uploaded.',
      data: expense
    });
  } catch (err) {
    next(err);
  }
};
