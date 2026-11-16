import mongoose from 'mongoose';
import {
  GoodsReceipt,
  InventoryBalance,
  InventoryItem,
  PurchaseInvoice,
  PurchaseOrder,
  PurchaseRequisition,
  SupplierPayment,
  SupplierReturn,
  Vendor
} from '../models/index.js';
import { logAudit } from '../services/auditService.js';
import { postStockMovement, runInventoryTransaction } from '../services/inventoryService.js';
import { resolveStorageLocation } from '../services/storageLocationService.js';
import { generateReference } from '../utils/reference.js';

const tenantFilter = (req) => ({
  hotelId: req.hotelId,
  propertyId: req.propertyId
});
const httpError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const isAdmin = (user) => ['hotel_admin', 'super_admin'].includes(user?.role);
const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));
const invoiceBalance = (invoice) => money(
  Number(invoice.grandTotal || 0) - Number(invoice.amountPaid || 0) - Number(invoice.creditAdjusted || 0)
);

export const getProcurementDashboard = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const [
      pendingRequisitions,
      pendingOrders,
      pendingReceipts,
      pendingInvoices,
      overdueInvoices,
      vendorTotals,
      monthlyReceipts,
      todayReceipts,
      returns
    ] = await Promise.all([
      PurchaseRequisition.countDocuments({ ...filter, status: 'pending' }),
      PurchaseOrder.countDocuments({ ...filter, status: { $in: ['draft', 'pending_approval'] } }),
      GoodsReceipt.countDocuments({ ...filter, inspectionStatus: 'pending' }),
      PurchaseInvoice.countDocuments({ ...filter, status: { $in: ['pending_verification', 'disputed'] } }),
      PurchaseInvoice.find({ ...filter, dueDate: { $lt: today }, status: { $in: ['approved', 'partially_paid', 'overdue'] } })
        .select('grandTotal amountPaid creditAdjusted').lean(),
      Vendor.aggregate([
        { $match: { hotelId: new mongoose.Types.ObjectId(req.hotelId) } },
        { $group: { _id: null, outstanding: { $sum: '$outstandingBalance' } } }
      ]),
      GoodsReceipt.aggregate([
        { $match: { ...filter, receivedAt: { $gte: monthStart }, inspectionStatus: { $in: ['not_required', 'completed'] } } },
        { $unwind: '$lines' },
        { $group: { _id: null, amount: { $sum: '$lines.acceptedQuantity' } } }
      ]),
      GoodsReceipt.aggregate([
        { $match: { ...filter, receivedAt: { $gte: today }, inspectionStatus: { $in: ['not_required', 'completed'] } } },
        { $group: { _id: null, count: { $sum: 1 } } }
      ]),
      SupplierReturn.countDocuments({ ...filter, status: { $ne: 'cancelled' } })
    ]);
    const overdueAmount = overdueInvoices.reduce((sum, invoice) => sum + Math.max(0, invoiceBalance(invoice)), 0);
    res.json({
      success: true,
      data: {
        pendingRequisitions,
        pendingOrders,
        pendingReceipts,
        pendingInvoices,
        overdueInvoices: overdueInvoices.length,
        overdueAmount: money(overdueAmount),
        supplierOutstanding: money(vendorTotals[0]?.outstanding || 0),
        receivedQuantityThisMonth: monthlyReceipts[0]?.amount || 0,
        receiptsToday: todayReceipts[0]?.count || 0,
        totalReturns: returns
      }
    });
  } catch (error) {
    next(error);
  }
};

export const listPurchaseRequisitions = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    const data = await PurchaseRequisition.find(filter)
      .populate('requestedBy reviewedBy', 'name role')
      .populate('requiredLocationId', 'locationName')
      .populate('lines.itemId', 'name code currentStock baseUnit unit')
      .populate('purchaseOrderId', 'poNumber status')
      .sort({ createdAt: -1 }).limit(300).lean();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const createPurchaseRequisition = async (req, res, next) => {
  try {
    const { department, requiredLocationId, lines, requiredDate, priority, reason, remarks } = req.body;
    if (!String(department || '').trim() || !Array.isArray(lines) || !lines.length) {
      throw httpError('Department and at least one requested material are required.');
    }
    const location = await resolveStorageLocation({
      hotelId: req.hotelId,
      locationId: requiredLocationId,
      locationName: req.body.requiredLocation
    });
    const parsedLines = [];
    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!isValidId(line.itemId) || !Number.isFinite(quantity) || quantity <= 0) {
        throw httpError('Choose a valid raw material and enter a requested quantity greater than zero.');
      }
      const item = await InventoryItem.findOne({
        _id: line.itemId, ...tenantFilter(req), isActive: true, inventoryType: 'raw_material'
      }).select('name unit baseUnit currentStock');
      if (!item) throw httpError('A requested material is invalid or inactive.');
      const balance = await InventoryBalance.findOne({
        ...tenantFilter(req), itemId: item._id,
        $or: [{ locationId: location._id }, { locationId: null, location: location.locationName }]
      }).select('quantity');
      parsedLines.push({
        itemId: item._id,
        itemName: item.name,
        quantity,
        unit: item.baseUnit || item.unit,
        availableQuantity: Number(balance?.quantity || 0)
      });
    }
    const requisition = await PurchaseRequisition.create({
      ...tenantFilter(req),
      requisitionNumber: generateReference('PR'),
      requestedBy: req.user._id,
      department: String(department).trim(),
      requiredLocationId: location._id,
      requiredLocation: location.locationName,
      requiredDate: requiredDate ? new Date(requiredDate) : null,
      priority: priority === 'urgent' ? 'urgent' : 'normal',
      reason: String(reason || '').trim(),
      remarks: String(remarks || '').trim(),
      lines: parsedLines
    });
    await logAudit({
      hotelId: req.hotelId, action: 'CREATE_PURCHASE_REQUISITION',
      entity: 'PurchaseRequisition', entityId: requisition._id,
      details: { requisitionNumber: requisition.requisitionNumber }, req
    });
    res.status(201).json({ success: true, data: requisition });
  } catch (error) {
    next(error);
  }
};

export const reviewPurchaseRequisition = async (req, res, next) => {
  try {
    const updated = await runInventoryTransaction(async (session) => {
      const requisition = await PurchaseRequisition.findOne({
        _id: req.params.id, ...tenantFilter(req), status: { $in: ['pending', 'partially_approved'] }
      }).session(session);
      if (!requisition) throw httpError('Open purchase requisition not found.', 404);
      const requestedLines = Array.isArray(req.body.lines) ? req.body.lines : [];
      const decisions = requisition.lines.map((line) => {
        const decision = requestedLines.find((entry) => String(entry.lineId) === String(line._id));
        const approvedQuantity = decision
          ? Number(decision.approvedQuantity)
          : req.body.decision === 'reject' ? 0 : Number(line.approvedQuantity ?? line.quantity);
        if (!Number.isFinite(approvedQuantity) || approvedQuantity < 0 || approvedQuantity > line.quantity) {
          throw httpError(`Approved quantity for ${line.itemName} must be between zero and the requested quantity.`);
        }
        line.approvedQuantity = approvedQuantity;
        return approvedQuantity;
      });
      if (req.body.decision === 'reject' || decisions.every((quantity) => quantity === 0)) {
        requisition.status = 'rejected';
      } else if (decisions.every((quantity, index) => quantity === Number(requisition.lines[index].quantity))) {
        requisition.status = 'approved';
      } else if (decisions.some((quantity) => quantity > 0)) {
        requisition.status = 'partially_approved';
      } else {
        throw httpError('Approve at least one item or reject the requisition.');
      }
      requisition.reviewedBy = req.user._id;
      requisition.reviewedAt = new Date();
      requisition.reviewNotes = String(req.body.notes || '').trim();
      await requisition.save({ session });
      return requisition;
    });
    await logAudit({
      hotelId: req.hotelId, action: 'REVIEW_PURCHASE_REQUISITION',
      entity: 'PurchaseRequisition', entityId: updated._id,
      details: { status: updated.status }, req
    });
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

export const createOrderFromRequisition = async (req, res, next) => {
  try {
    const order = await runInventoryTransaction(async (session) => {
      const requisition = await PurchaseRequisition.findOne({
        _id: req.params.id, ...tenantFilter(req), status: { $in: ['approved', 'partially_approved'] },
        purchaseOrderId: null
      }).session(session);
      if (!requisition) throw httpError('Approved requisition is not available for purchase order creation.', 409);
      const vendor = await Vendor.findOne({
        _id: req.body.vendorId, hotelId: req.hotelId, status: 'active'
      }).session(session);
      if (!vendor) throw httpError('Choose an active supplier.');
      const prices = new Map((req.body.items || []).map((line) => [String(line.itemId), Number(line.unitCost)]));
      const lines = [];
      for (const requested of requisition.lines.filter((line) => Number(line.approvedQuantity) > 0)) {
        const item = await InventoryItem.findOne({
          _id: requested.itemId, ...tenantFilter(req), isActive: true, inventoryType: 'raw_material'
        }).session(session);
        const unitCost = prices.get(String(requested.itemId));
        if (!item || !Number.isFinite(unitCost) || unitCost < 0) {
          throw httpError(`Enter a valid supplier price for ${requested.itemName}.`);
        }
        const baseUnit = item.baseUnit || item.unit;
        lines.push({
          itemId: item._id,
          itemName: item.name,
          quantity: Number(requested.approvedQuantity),
          receivedQuantity: 0,
          unit: baseUnit,
          unitId: item.baseUnitId || null,
          unitNameSnapshot: baseUnit,
          unitSymbolSnapshot: baseUnit,
          baseUnit,
          baseUnitId: item.baseUnitId || null,
          baseUnitNameSnapshot: baseUnit,
          baseUnitSymbolSnapshot: baseUnit,
          conversionFactor: 1,
          unitCost,
          totalAmount: money(Number(requested.approvedQuantity) * unitCost)
        });
      }
      if (!lines.length) throw httpError('The requisition has no approved quantities.');
      const subtotal = money(lines.reduce((sum, line) => sum + line.totalAmount, 0));
      const taxAmount = Number(req.body.taxAmount || 0);
      const discountAmount = Number(req.body.discountAmount || 0);
      const otherCharges = Number(req.body.otherCharges || 0);
      if (![taxAmount, discountAmount, otherCharges].every(Number.isFinite)
        || taxAmount < 0 || discountAmount < 0 || discountAmount > subtotal || otherCharges < 0) {
        throw httpError('Tax, discount, and charges must be valid; discount cannot exceed the subtotal.');
      }
      const [created] = await PurchaseOrder.create([{
        ...tenantFilter(req),
        poNumber: generateReference('PO'),
        vendorId: vendor._id,
        items: lines,
        subtotal,
        taxAmount,
        discountAmount,
        totalAmount: money(subtotal + taxAmount + otherCharges - discountAmount),
        status: 'pending_approval',
        expectedDeliveryDate: req.body.expectedDeliveryDate || undefined,
        department: requisition.department,
        purchaseRequestId: requisition._id,
        deliveryLocationId: requisition.requiredLocationId,
        deliveryLocation: requisition.requiredLocation,
        paymentTermsSnapshot: vendor.paymentTerms,
        deliveryInstructions: String(req.body.deliveryInstructions || '').trim(),
        notes: String(req.body.notes || '').trim(),
        createdBy: req.user._id
      }], { session });
      requisition.purchaseOrderId = created._id;
      requisition.status = 'ordered';
      await requisition.save({ session });
      return created;
    });
    await logAudit({
      hotelId: req.hotelId, action: 'CREATE_PO_FROM_REQUISITION',
      entity: 'PurchaseOrder', entityId: order._id,
      details: { poNumber: order.poNumber, requisitionId: req.params.id }, req
    });
    res.status(201).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const reviewProcurementOrder = async (req, res, next) => {
  try {
    if (req.body.action === 'reject' && !String(req.body.reason || '').trim()) {
      throw httpError('Enter a reason to reject the purchase order.');
    }
    const order = await PurchaseOrder.findOne({
      _id: req.params.id, ...tenantFilter(req), status: { $in: ['draft', 'pending_approval'] }
    });
    if (!order) throw httpError('Pending purchase order not found.', 404);
    if (req.body.action === 'reject') {
      order.status = 'rejected';
      order.notes = [order.notes, `Rejected: ${String(req.body.reason).trim()}`].filter(Boolean).join('\n');
    } else {
      order.status = 'ordered';
      order.approvedBy = req.user._id;
      order.approvedAt = new Date();
    }
    await order.save();
    await logAudit({
      hotelId: req.hotelId, action: req.body.action === 'reject' ? 'REJECT_PURCHASE_ORDER' : 'APPROVE_PURCHASE_ORDER',
      entity: 'PurchaseOrder', entityId: order._id, details: { poNumber: order.poNumber }, req
    });
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const cancelProcurementOrder = async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw httpError('A cancellation reason is required.');
    const order = await PurchaseOrder.findOne({
      _id: req.params.id, ...tenantFilter(req),
      status: { $in: ['draft', 'pending_approval', 'approved', 'ordered'] }
    });
    if (!order) throw httpError('Purchase order cannot be cancelled in its current state.', 409);
    if (order.items.some((line) => Number(line.receivedQuantity) > 0)) {
      throw httpError('A purchase order with received goods cannot be cancelled; close or amend its remaining quantities.', 409);
    }
    order.status = 'cancelled';
    order.cancellationReason = reason;
    order.cancelledBy = req.user._id;
    order.cancelledAt = new Date();
    await order.save();
    await logAudit({
      hotelId: req.hotelId, action: 'CANCEL_PURCHASE_ORDER',
      entity: 'PurchaseOrder', entityId: order._id, details: { reason }, req
    });
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const listPurchaseInvoices = async (req, res, next) => {
  try {
    const filter = tenantFilter(req);
    if (req.query.status) filter.status = req.query.status;
    const data = await PurchaseInvoice.find(filter)
      .populate('vendorId', 'name supplierCode taxNumber')
      .populate('purchaseOrderId', 'poNumber status')
      .populate('goodsReceiptIds', 'receiptNumber receivedAt')
      .populate('enteredBy verifiedBy approvedBy', 'name')
      .sort({ invoiceDate: -1 }).limit(500).lean();
    res.json({
      success: true,
      data: data.map((invoice) => ({ ...invoice, outstandingAmount: invoiceBalance(invoice) }))
    });
  } catch (error) {
    next(error);
  }
};

export const createPurchaseInvoice = async (req, res, next) => {
  try {
    const result = await runInventoryTransaction(async (session) => {
      const idempotencyKey = req.body.idempotencyKey || req.get('Idempotency-Key');
      if (idempotencyKey) {
        const duplicate = await PurchaseInvoice.findOne({
          ...tenantFilter(req), idempotencyKey
        }).session(session);
        if (duplicate) return { invoice: duplicate, duplicate: true };
      }
      const order = await PurchaseOrder.findOne({
        _id: req.body.purchaseOrderId, ...tenantFilter(req), status: { $nin: ['draft', 'pending_approval', 'rejected', 'cancelled'] }
      }).session(session);
      const vendor = order && await Vendor.findOne({ _id: order.vendorId, hotelId: req.hotelId }).session(session);
      if (!order || !vendor) throw httpError('Choose an approved purchase order and its supplier.');
      const invoiceDate = new Date(req.body.invoiceDate);
      const dueDate = new Date(req.body.dueDate);
      if (Number.isNaN(invoiceDate.getTime()) || Number.isNaN(dueDate.getTime())) {
        throw httpError('Enter valid supplier invoice and due dates.');
      }
      const invoiceNumber = String(req.body.supplierInvoiceNumber || '').trim();
      if (!invoiceNumber) throw httpError('Supplier invoice number is required.');
      const duplicateNumber = await PurchaseInvoice.exists({
        ...tenantFilter(req), vendorId: vendor._id, supplierInvoiceNumber: invoiceNumber
      }).session(session);
      if (duplicateNumber) throw httpError('This supplier invoice number is already recorded.', 409);
      const receivedIds = [...new Set((req.body.lines || []).map((line) => String(line.goodsReceiptId)))];
      if (!receivedIds.length || receivedIds.some((id) => !isValidId(id))) {
        throw httpError('Link invoice lines to a goods receipt.');
      }
      const receipts = await GoodsReceipt.find({
        _id: { $in: receivedIds }, ...tenantFilter(req), purchaseOrderId: order._id,
        inspectionStatus: { $in: ['not_required', 'completed'] }
      }).session(session);
      if (receipts.length !== receivedIds.length) {
        throw httpError('Every invoice receipt must belong to this order and have completed its inspection.');
      }
      const parsed = [];
      let quantityVariance = false;
      let priceVariance = false;
      const taxMode = req.body.taxMode ?? 'legacy';
      if (!['legacy', 'intra_state', 'inter_state'].includes(taxMode)) {
        throw httpError('Choose a valid invoice tax mode.');
      }
      const currentInvoiceQuantities = new Map();
      for (const line of req.body.lines || []) {
        const receipt = receipts.find((entry) => String(entry._id) === String(line.goodsReceiptId));
        const receiptLine = receipt.lines.find((entry) => String(entry.itemId) === String(line.itemId));
        const poLine = order.items.find((entry) => String(entry.itemId) === String(line.itemId));
        const quantity = Number(line.quantity);
        const unitPrice = Number(line.unitPrice);
        const gstRate = Number(line.gstRate || 0);
        const discountAmount = Number(line.discountAmount || 0);
        if (!receiptLine || !poLine || ![quantity, unitPrice, gstRate, discountAmount].every(Number.isFinite)
          || quantity <= 0 || unitPrice < 0 || gstRate < 0 || gstRate > 100 || discountAmount < 0) {
          throw httpError('Invoice line contains an invalid material, quantity, price, discount, or tax rate.');
        }
        const previouslyInvoiced = await PurchaseInvoice.aggregate([
          { $match: { ...tenantFilter(req), status: { $ne: 'cancelled' }, purchaseOrderId: order._id } },
          { $unwind: '$lines' },
          { $match: { 'lines.itemId': receiptLine.itemId, 'lines.goodsReceiptId': receipt._id } },
          { $group: { _id: null, quantity: { $sum: '$lines.quantity' } } }
        ]).session(session);
        const remainingAccepted = Math.max(
          0,
          Number(receiptLine.acceptedQuantity) - Number(previouslyInvoiced[0]?.quantity || 0)
        );
        const quantityKey = `${receipt._id}:${receiptLine.itemId}`;
        const cumulativeQuantity = (currentInvoiceQuantities.get(quantityKey) || 0) + quantity;
        currentInvoiceQuantities.set(quantityKey, cumulativeQuantity);
        if (cumulativeQuantity > remainingAccepted) quantityVariance = true;
        const taxableAmount = money(quantity * unitPrice - discountAmount);
        if (taxableAmount < 0) throw httpError('Invoice line discount cannot exceed its value.');
        const taxAmount = money(taxableAmount * gstRate / 100);
        const cgstRate = taxMode === 'intra_state' ? gstRate / 2 : 0;
        const sgstRate = taxMode === 'intra_state' ? gstRate / 2 : 0;
        const igstRate = taxMode === 'inter_state' ? gstRate : 0;
        const cgstAmount = money(taxableAmount * cgstRate / 100);
        const sgstAmount = taxMode === 'intra_state' ? money(taxAmount - cgstAmount) : 0;
        const igstAmount = taxMode === 'inter_state' ? taxAmount : 0;
        const expectedUnitPrice = Number(receiptLine.unitCost || poLine.unitCost);
        if (Math.abs(unitPrice - expectedUnitPrice) > 0.01) priceVariance = true;
        parsed.push({
          itemId: receiptLine.itemId,
          itemName: poLine.itemName,
          goodsReceiptId: receipt._id,
          quantity,
          unit: line.unit || receiptLine.unit,
          unitPrice,
          discountAmount,
          gstRate,
          cgstRate,
          sgstRate,
          igstRate,
          taxableAmount,
          taxAmount,
          cgstAmount,
          sgstAmount,
          igstAmount,
          totalAmount: money(taxableAmount + taxAmount)
        });
      }
      if (!parsed.length) throw httpError('At least one invoice line is required.');
      const subtotal = money(parsed.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0));
      const discountTotal = money(parsed.reduce((sum, line) => sum + line.discountAmount, 0));
      const taxTotal = money(parsed.reduce((sum, line) => sum + line.taxAmount, 0));
      const cgstTotal = money(parsed.reduce((sum, line) => sum + line.cgstAmount, 0));
      const sgstTotal = money(parsed.reduce((sum, line) => sum + line.sgstAmount, 0));
      const igstTotal = money(parsed.reduce((sum, line) => sum + line.igstAmount, 0));
      const otherCharges = Number(req.body.otherCharges || 0);
      const roundOff = Number(req.body.roundOff || 0);
      if (![otherCharges, roundOff].every(Number.isFinite) || otherCharges < 0) {
        throw httpError('Additional charges and round-off must be valid.');
      }
      const grandTotal = money(subtotal - discountTotal + taxTotal + otherCharges + roundOff);
      const [invoice] = await PurchaseInvoice.create([{
        ...tenantFilter(req),
        internalInvoiceId: generateReference('PINV'),
        supplierInvoiceNumber: invoiceNumber,
        invoiceDate,
        dueDate,
        vendorId: vendor._id,
        purchaseOrderId: order._id,
        goodsReceiptIds: receivedIds,
        invoiceType: req.body.invoiceType || 'tax_invoice',
        taxMode,
        supplierGSTIN: req.body.supplierGSTIN || vendor.taxNumber,
        hotelGSTIN: req.body.hotelGSTIN || '',
        placeOfSupply: req.body.placeOfSupply || '',
        paymentTerms: req.body.paymentTerms || vendor.paymentTerms,
        attachment: req.body.attachment || '',
        lines: parsed,
        subtotal,
        discountTotal,
        taxTotal,
        cgstTotal,
        sgstTotal,
        igstTotal,
        otherCharges,
        roundOff,
        grandTotal,
        quantityVariance,
        priceVariance,
        status: 'pending_verification',
        enteredBy: req.user._id,
        idempotencyKey
      }], { session });
      return { invoice, duplicate: false };
    });
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId, action: 'CREATE_PURCHASE_INVOICE',
        entity: 'PurchaseInvoice', entityId: result.invoice._id,
        details: { supplierInvoiceNumber: result.invoice.supplierInvoiceNumber, grandTotal: result.invoice.grandTotal }, req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const verifyPurchaseInvoice = async (req, res, next) => {
  try {
    const invoice = await PurchaseInvoice.findOne({
      _id: req.params.id, ...tenantFilter(req), status: { $in: ['pending_verification', 'disputed'] }
    });
    if (!invoice) throw httpError('Invoice awaiting verification was not found.', 404);
    const authorizeVariance = req.body.authorizeVariance === true && isAdmin(req.user);
    if ((invoice.quantityVariance || invoice.priceVariance) && !authorizeVariance) {
      invoice.status = 'disputed';
      invoice.verificationNotes = String(req.body.notes || '').trim();
    } else {
      invoice.status = 'verified';
      invoice.verifiedBy = req.user._id;
      invoice.verifiedAt = new Date();
      invoice.verificationNotes = String(req.body.notes || '').trim();
    }
    await invoice.save();
    await logAudit({
      hotelId: req.hotelId, action: invoice.status === 'disputed' ? 'DISPUTE_PURCHASE_INVOICE' : 'VERIFY_PURCHASE_INVOICE',
      entity: 'PurchaseInvoice', entityId: invoice._id,
      details: { authorizeVariance, notes: invoice.verificationNotes }, req
    });
    res.json({ success: true, data: invoice });
  } catch (error) {
    next(error);
  }
};

export const approvePurchaseInvoice = async (req, res, next) => {
  try {
    const invoice = await runInventoryTransaction(async (session) => {
      const current = await PurchaseInvoice.findOne({
        _id: req.params.id, ...tenantFilter(req), status: 'verified'
      }).session(session);
      if (!current) throw httpError('Only a verified supplier invoice can be approved.', 409);
      current.status = 'approved';
      current.approvedBy = req.user._id;
      current.approvedAt = new Date();
      await current.save({ session });
      await Vendor.updateOne(
        { _id: current.vendorId, hotelId: req.hotelId },
        { $inc: { outstandingBalance: current.grandTotal } },
        { session }
      );
      return current;
    });
    await logAudit({
      hotelId: req.hotelId, action: 'APPROVE_PURCHASE_INVOICE',
      entity: 'PurchaseInvoice', entityId: invoice._id,
      details: { amount: invoice.grandTotal }, req
    });
    res.json({ success: true, data: { ...invoice.toObject(), outstandingAmount: invoiceBalance(invoice) } });
  } catch (error) {
    next(error);
  }
};

export const createInvoicePayment = async (req, res, next) => {
  try {
    const idempotencyKey = req.body.idempotencyKey || req.get('Idempotency-Key');
    const result = await runInventoryTransaction(async (session) => {
      if (idempotencyKey) {
        const duplicate = await SupplierPayment.findOne({
          ...tenantFilter(req), idempotencyKey
        }).session(session);
        if (duplicate) return { payment: duplicate, duplicate: true };
      }
      const vendor = await Vendor.findOne({ _id: req.body.vendorId, hotelId: req.hotelId }).session(session);
      if (!vendor || !Array.isArray(req.body.allocations) || !req.body.allocations.length) {
        throw httpError('Choose a supplier and allocate the payment to at least one invoice.');
      }
      const allocations = [];
      let total = 0;
      const seen = new Set();
      for (const entry of req.body.allocations) {
        const amount = Number(entry.amount);
        if (!isValidId(entry.invoiceId) || !Number.isFinite(amount) || amount <= 0
          || seen.has(String(entry.invoiceId))) {
          throw httpError('Each invoice allocation must have a unique invoice and a positive amount.');
        }
        seen.add(String(entry.invoiceId));
        const invoice = await PurchaseInvoice.findOne({
          _id: entry.invoiceId, ...tenantFilter(req), vendorId: vendor._id,
          status: { $in: ['approved', 'partially_paid', 'overdue'] }
        }).session(session);
        if (!invoice || amount > invoiceBalance(invoice)) {
          throw httpError('An invoice was not found or the payment exceeds its outstanding amount.', 409);
        }
        invoice.amountPaid = money(Number(invoice.amountPaid || 0) + amount);
        invoice.status = invoiceBalance(invoice) <= 0 ? 'paid' : 'partially_paid';
        await invoice.save({ session });
        allocations.push({ invoiceId: invoice._id, amount });
        total += amount;
      }
      const amount = money(total);
      const [payment] = await SupplierPayment.create([{
        ...tenantFilter(req),
        vendorId: vendor._id,
        amount,
        paymentMethod: req.body.paymentMethod || 'bank_transfer',
        referenceNumber: String(req.body.referenceNumber || '').trim(),
        invoiceNumber: allocations.length === 1 ? String(req.body.invoiceNumber || '') : '',
        notes: String(req.body.notes || '').trim(),
        attachment: String(req.body.attachment || '').trim(),
        allocations,
        idempotencyKey,
        recordedBy: req.user._id,
        paidAt: req.body.paidAt ? new Date(req.body.paidAt) : new Date()
      }], { session });
      const update = await Vendor.updateOne({
        _id: vendor._id, hotelId: req.hotelId,
        outstandingBalance: { $gte: amount }
      }, { $inc: { outstandingBalance: -amount } }, { session });
      if (update.modifiedCount !== 1) {
        throw httpError('Payment exceeds the supplier payable balance.', 409);
      }
      return { payment, duplicate: false };
    });
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId, action: 'ALLOCATE_SUPPLIER_PAYMENT',
        entity: 'SupplierPayment', entityId: result.payment._id,
        details: { amount: result.payment.amount, allocations: result.payment.allocations }, req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const listSupplierReturns = async (req, res, next) => {
  try {
    const data = await SupplierReturn.find(tenantFilter(req))
      .populate('vendorId', 'name supplierCode')
      .populate('purchaseOrderId', 'poNumber')
      .populate('goodsReceiptId', 'receiptNumber')
      .populate('invoiceId', 'supplierInvoiceNumber grandTotal status')
      .populate('requestedBy approvedBy completedBy', 'name')
      .sort({ createdAt: -1 }).limit(500).lean();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const createSupplierReturn = async (req, res, next) => {
  try {
    const result = await runInventoryTransaction(async (session) => {
      const key = req.body.idempotencyKey || req.get('Idempotency-Key');
      if (key) {
        const duplicate = await SupplierReturn.findOne({ ...tenantFilter(req), idempotencyKey: key }).session(session);
        if (duplicate) return { supplierReturn: duplicate, duplicate: true };
      }
      const receipt = await GoodsReceipt.findOne({
        _id: req.body.goodsReceiptId, ...tenantFilter(req), inspectionStatus: { $in: ['completed', 'not_required'] }
      }).session(session);
      if (!receipt) throw httpError('Choose a received and inspected goods receipt.');
      const order = await PurchaseOrder.findOne({
        _id: receipt.purchaseOrderId, ...tenantFilter(req)
      }).session(session);
      const vendor = order && await Vendor.findOne({ _id: order.vendorId, hotelId: req.hotelId }).session(session);
      if (!order || !vendor) throw httpError('Goods receipt supplier could not be resolved.');
      let totalValue = 0;
      const lines = [];
      const currentReturnQuantities = new Map();
      for (const input of req.body.lines || []) {
        const receiptLine = receipt.lines.find((line) => String(line.itemId) === String(input.itemId));
        const quantity = Number(input.quantity);
        if (!receiptLine || !Number.isFinite(quantity) || quantity <= 0) {
          throw httpError('Supplier return contains an invalid item or quantity.');
        }
        const priorReturns = await SupplierReturn.aggregate([
          { $match: { ...tenantFilter(req), goodsReceiptId: receipt._id, status: { $in: ['approved', 'completed'] } } },
          { $unwind: '$lines' },
          { $match: { 'lines.itemId': receiptLine.itemId } },
          { $group: { _id: null, quantity: { $sum: '$lines.quantity' } } }
        ]).session(session);
        const eligible = Math.max(0,
          Number(receiptLine.acceptedQuantity) - Number(priorReturns[0]?.quantity || 0));
        const quantityKey = `${receipt._id}:${receiptLine.itemId}`;
        const cumulativeQuantity = (currentReturnQuantities.get(quantityKey) || 0) + quantity;
        currentReturnQuantities.set(quantityKey, cumulativeQuantity);
        if (cumulativeQuantity > eligible) {
          throw httpError(`Return quantity exceeds eligible accepted stock for ${input.itemName || 'this item'}.`, 409);
        }
        const conversionFactor = Number(receiptLine.conversionFactor || 1);
        const unitValue = Number(receiptLine.unitCost || 0);
        totalValue += quantity * unitValue;
        lines.push({
          itemId: receiptLine.itemId,
          itemName: order.items.find((entry) => String(entry.itemId) === String(receiptLine.itemId))?.itemName || 'Inventory item',
          goodsReceiptId: receipt._id,
          quantity,
          unit: receiptLine.unit,
          conversionFactor,
          unitValue
        });
      }
      if (!lines.length) throw httpError('At least one return line is required.');
      const invoice = req.body.invoiceId
        ? await PurchaseInvoice.findOne({
          _id: req.body.invoiceId, ...tenantFilter(req), vendorId: vendor._id, purchaseOrderId: order._id
        }).session(session)
        : null;
      if (req.body.invoiceId && !invoice) throw httpError('Linked supplier invoice is not valid for this order.');
      const [supplierReturn] = await SupplierReturn.create([{
        ...tenantFilter(req),
        returnNumber: generateReference('RET'),
        vendorId: vendor._id,
        purchaseOrderId: order._id,
        goodsReceiptId: receipt._id,
        invoiceId: invoice?._id || null,
        reason: String(req.body.reason || '').trim(),
        notes: String(req.body.notes || '').trim(),
        lines,
        totalValue: money(totalValue),
        idempotencyKey: key,
        requestedBy: req.user._id
      }], { session });
      return { supplierReturn, duplicate: false };
    });
    if (!result.duplicate) {
      await logAudit({
        hotelId: req.hotelId, action: 'CREATE_SUPPLIER_RETURN',
        entity: 'SupplierReturn', entityId: result.supplierReturn._id,
        details: { returnNumber: result.supplierReturn.returnNumber }, req
      });
    }
    res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const approveSupplierReturn = async (req, res, next) => {
  try {
    const supplierReturn = await SupplierReturn.findOne({
      _id: req.params.id, ...tenantFilter(req), status: 'requested'
    });
    if (!supplierReturn) throw httpError('Supplier return request not found.', 404);
    supplierReturn.status = 'approved';
    supplierReturn.approvedBy = req.user._id;
    supplierReturn.approvedAt = new Date();
    await supplierReturn.save();
    await logAudit({
      hotelId: req.hotelId, action: 'APPROVE_SUPPLIER_RETURN',
      entity: 'SupplierReturn', entityId: supplierReturn._id, req
    });
    res.json({ success: true, data: supplierReturn });
  } catch (error) {
    next(error);
  }
};

export const completeSupplierReturn = async (req, res, next) => {
  try {
    const supplierReturn = await runInventoryTransaction(async (session) => {
      const current = await SupplierReturn.findOne({
        _id: req.params.id, ...tenantFilter(req), status: 'approved'
      }).session(session);
      if (!current) throw httpError('Only an approved supplier return can be completed.', 409);
      const receipt = await GoodsReceipt.findOne({
        _id: current.goodsReceiptId, ...tenantFilter(req)
      }).session(session);
      if (!receipt) throw httpError('Linked goods receipt not found.', 404);
      for (const line of current.lines) {
        await postStockMovement({
          hotelId: req.hotelId,
          propertyId: req.propertyId,
          itemId: line.itemId,
          movementType: 'issue',
          quantity: line.quantity,
          unit: line.unit,
          conversionFactor: line.conversionFactor,
          location: receipt.location,
          locationId: receipt.locationId,
          referenceNumber: current.returnNumber,
          notes: `Supplier return ${current.returnNumber}: ${current.reason}`,
          recordedBy: req.user._id,
          idempotencyKey: `supplier-return:${current._id}:${line._id}`,
          metadata: { supplierReturnId: String(current._id), returnReason: current.reason },
          session
        });
        line.stockDeducted = true;
      }
      current.status = 'completed';
      current.completedBy = req.user._id;
      current.completedAt = new Date();
      current.creditNoteNumber = String(req.body.creditNoteNumber || '').trim();
      if (current.invoiceId && current.creditNoteNumber) {
        const invoice = await PurchaseInvoice.findOne({
          _id: current.invoiceId, ...tenantFilter(req), vendorId: current.vendorId
        }).session(session);
        if (!invoice) throw httpError('Linked invoice no longer exists.', 409);
        const adjustment = Math.min(invoiceBalance(invoice), current.totalValue);
        invoice.creditAdjusted = money(Number(invoice.creditAdjusted || 0) + adjustment);
        if (invoiceBalance(invoice) <= 0) invoice.status = invoice.amountPaid > 0 ? 'paid' : 'approved';
        await invoice.save({ session });
        if (adjustment > 0) {
          const vendorUpdate = await Vendor.updateOne({
            _id: current.vendorId, hotelId: req.hotelId,
            outstandingBalance: { $gte: adjustment }
          }, { $inc: { outstandingBalance: -adjustment } }, { session });
          if (vendorUpdate.modifiedCount !== 1) {
            throw httpError('Supplier balance cannot cover this credit adjustment.', 409);
          }
        }
      }
      await current.save({ session });
      return current;
    });
    await logAudit({
      hotelId: req.hotelId, action: 'COMPLETE_SUPPLIER_RETURN',
      entity: 'SupplierReturn', entityId: supplierReturn._id,
      details: { returnNumber: supplierReturn.returnNumber, totalValue: supplierReturn.totalValue }, req
    });
    res.json({ success: true, data: supplierReturn });
  } catch (error) {
    next(error);
  }
};

export const inspectGoodsReceipt = async (req, res, next) => {
  try {
    const receipt = await runInventoryTransaction(async (session) => {
      const current = await GoodsReceipt.findOne({
        _id: req.params.id, ...tenantFilter(req), inspectionStatus: 'pending'
      }).session(session);
      if (!current) throw httpError('Goods receipt is not awaiting quality inspection.', 409);
      const order = await PurchaseOrder.findOne({
        _id: current.purchaseOrderId, ...tenantFilter(req)
      }).session(session);
      if (!order) throw httpError('Linked purchase order was not found.', 404);
      const decisions = Array.isArray(req.body.lines) ? req.body.lines : [];
      if (decisions.length !== current.lines.length) {
        throw httpError('Record an inspection decision for every received line.');
      }
      const temperatureCelsius = req.body.temperatureCelsius === '' || req.body.temperatureCelsius == null
        ? null
        : Number(req.body.temperatureCelsius);
      if (temperatureCelsius !== null && !Number.isFinite(temperatureCelsius)) {
        throw httpError('Inspection temperature must be a valid number.');
      }
      const storageLocation = await resolveStorageLocation({
        hotelId: req.hotelId, locationId: current.locationId, locationName: current.location, session
      });
      for (let index = 0; index < current.lines.length; index += 1) {
        const line = current.lines[index];
        const decision = decisions[index];
        const acceptedQuantity = Number(decision.acceptedQuantity);
        const rejectedQuantity = Number(decision.rejectedQuantity || 0);
        const damagedQuantity = Number(decision.damagedQuantity || 0);
        if (![acceptedQuantity, rejectedQuantity, damagedQuantity].every(Number.isFinite)
          || acceptedQuantity < 0 || rejectedQuantity < 0 || damagedQuantity < 0
          || Math.abs(acceptedQuantity + rejectedQuantity + damagedQuantity - line.receivedQuantity) > 1e-8) {
          throw httpError(`Accepted, rejected, and damaged quantities must equal received quantity for line ${index + 1}.`);
        }
        const expiryDate = decision.expiryDate ? new Date(decision.expiryDate) : line.expiryDate;
        if (expiryDate && Number.isNaN(new Date(expiryDate).getTime())) throw httpError('Inspection includes an invalid expiry date.');
        line.acceptedQuantity = acceptedQuantity;
        line.rejectedQuantity = rejectedQuantity;
        line.damagedQuantity = damagedQuantity;
        line.inspectionPendingQuantity = 0;
        line.expiryDate = expiryDate;
        if (acceptedQuantity > 0) {
          const taxInclusiveUnitCost = Number(line.taxInclusiveUnitCost ?? line.unitCost);
          await postStockMovement({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: line.itemId,
            movementType: 'receipt',
            quantity: acceptedQuantity,
            unit: line.unit,
            unitId: line.unitId,
            conversionFactor: line.conversionFactor || 1,
            purchasePackageId: line.purchasePackageId || null,
            purchasePackageName: line.packageNameSnapshot || '',
            purchasePackageSnapshot: Boolean(line.purchasePackageId),
            unitCost: taxInclusiveUnitCost / (line.conversionFactor || 1),
            location: storageLocation.locationName,
            locationId: storageLocation._id,
            referenceNumber: current.receiptNumber,
            notes: `Quality-accepted goods receipt ${current.receiptNumber}`,
            recordedBy: req.user._id,
            idempotencyKey: `grn-inspection:${current._id}:${index}`,
            batchNumber: line.batchNumber,
            expiryDate,
            transactionDate: current.receivedAt,
            receivedAt: current.receivedAt,
            batchDetails: {
              purchaseQuantity: acceptedQuantity,
              purchaseUnit: line.unit,
              purchaseUnitCost: line.unitCost,
              purchaseAmount: money(acceptedQuantity * line.unitCost),
              purchaseTaxAmount: line.purchaseTaxAmount,
              purchaseTaxInclusiveUnitCost: taxInclusiveUnitCost,
              vendorId: order.vendorId,
              purchaseOrderId: order._id,
              invoiceNumber: current.invoiceNumber
            },
            session
          });
        }
      }
      current.inspectionStatus = 'completed';
      current.inspection = {
        materialCondition: String(req.body.materialCondition || '').trim(),
        freshness: String(req.body.freshness || '').trim(),
        packagingCondition: String(req.body.packagingCondition || '').trim(),
        temperatureCelsius,
        remarks: String(req.body.remarks || '').trim(),
        inspectedBy: req.user._id,
        inspectedAt: new Date()
      };
      await current.save({ session });
      return current;
    });
    await logAudit({
      hotelId: req.hotelId, action: 'INSPECT_GOODS_RECEIPT',
      entity: 'GoodsReceipt', entityId: receipt._id,
      details: { receiptNumber: receipt.receiptNumber, inspection: receipt.inspection }, req
    });
    res.json({ success: true, data: receipt });
  } catch (error) {
    next(error);
  }
};

export const exportProcurementReport = async (req, res, next) => {
  try {
    const type = String(req.query.type || 'overview');
    const from = req.query.from ? new Date(req.query.from) : new Date(0);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw httpError('Choose a valid report date range.');
    }
    const range = { $gte: from, $lte: to };
    const filter = tenantFilter(req);
    const [orders, receipts, invoices, returns, payments] = await Promise.all([
      PurchaseOrder.find({ ...filter, createdAt: range }).populate('vendorId', 'name supplierCode').lean(),
      GoodsReceipt.find({ ...filter, receivedAt: range }).populate('purchaseOrderId', 'poNumber vendorId').lean(),
      PurchaseInvoice.find({ ...filter, invoiceDate: range }).populate('vendorId', 'name supplierCode').lean(),
      SupplierReturn.find({ ...filter, createdAt: range }).populate('vendorId', 'name supplierCode').lean(),
      SupplierPayment.find({ ...filter, paidAt: range }).populate('vendorId', 'name supplierCode').lean()
    ]);
    let rows;
    if (type === 'orders') rows = orders;
    else if (type === 'receipts') rows = receipts;
    else if (type === 'invoices') rows = invoices.map((invoice) => ({ ...invoice, outstandingAmount: invoiceBalance(invoice) }));
    else if (type === 'returns') rows = returns;
    else if (type === 'payments') rows = payments;
    else rows = [
      ...orders.map((entry) => ({ documentType: 'purchase_order', documentNumber: entry.poNumber, date: entry.createdAt, vendor: entry.vendorId?.name || '', amount: entry.totalAmount, status: entry.status })),
      ...receipts.map((entry) => ({ documentType: 'goods_receipt', documentNumber: entry.receiptNumber, date: entry.receivedAt, vendor: '', amount: entry.lines.reduce((sum, line) => sum + line.acceptedQuantity * line.unitCost, 0), status: entry.inspectionStatus })),
      ...invoices.map((entry) => ({ documentType: 'supplier_invoice', documentNumber: entry.supplierInvoiceNumber, date: entry.invoiceDate, vendor: entry.vendorId?.name || '', amount: entry.grandTotal, outstanding: invoiceBalance(entry), status: entry.status })),
      ...returns.map((entry) => ({ documentType: 'supplier_return', documentNumber: entry.returnNumber, date: entry.createdAt, vendor: entry.vendorId?.name || '', amount: entry.totalValue, status: entry.status })),
      ...payments.map((entry) => ({ documentType: 'supplier_payment', documentNumber: entry.referenceNumber, date: entry.paidAt, vendor: entry.vendorId?.name || '', amount: entry.amount, status: 'paid' }))
    ];
    res.json({ success: true, data: { type, from, to, rows } });
  } catch (error) {
    next(error);
  }
};
