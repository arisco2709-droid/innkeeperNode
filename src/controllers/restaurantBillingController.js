import mongoose from 'mongoose';
import {
  FoodOrder,
  Hotel,
  Invoice,
  Payment,
  PreparedFoodMovement,
  Property,
  RecipeConsumption,
  RestaurantBillingReportVisibility,
  Refund,
  StockMovement
} from '../models/index.js';
import { combineHotelDateAndTime, getHotelLocalDate } from '../utils/reservationDates.js';
import { logAudit } from '../services/auditService.js';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const addCalendarDays = (date, offset) => {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + offset));
  return value.toISOString().slice(0, 10);
};

const getDayRange = (date, timeZone) => {
  const start = combineHotelDateAndTime(date, '00:00', timeZone);
  const end = combineHotelDateAndTime(addCalendarDays(date, 1), '00:00', timeZone);
  if (!start || !end || end <= start) return null;
  return { start, end };
};

const getBillingReportScope = async (req) => {
  const hotelId = req.hotelId;
  if (!hotelId || !mongoose.isValidObjectId(hotelId)) {
    throw Object.assign(new Error('A valid hotel is required.'), { statusCode: 400 });
  }
  const hotel = req.hotel || await Hotel.findById(hotelId).select('timezone');
  if (!hotel) throw Object.assign(new Error('Hotel not found.'), { statusCode: 404 });

  let propertyId = req.propertyId || req.user?.propertyId
    || (req.user?.role === 'super_admin' && req.query.propertyId);
  if (!propertyId && req.user?.role === 'super_admin') {
    const defaultProperty = await Property.findOne({ hotelId, status: 'active' }).select('_id').sort({ createdAt: 1 });
    propertyId = defaultProperty?._id;
  }
  if (!propertyId || !mongoose.isValidObjectId(propertyId)) {
    throw Object.assign(new Error('A valid restaurant property is required.'), { statusCode: 400 });
  }
  const property = await Property.findOne({ _id: propertyId, hotelId, status: 'active' }).select('_id');
  if (!property) throw Object.assign(new Error('Restaurant property not found or inactive.'), { statusCode: 404 });

  const timeZone = hotel.timezone || 'UTC';
  const todayDate = getHotelLocalDate(timeZone);
  const reportDates = Array.from({ length: 6 }, (_, index) => addCalendarDays(todayDate, -index));
  return { hotelId, propertyId: property._id, hotel, timeZone, todayDate, reportDates };
};

const isPreviousReportDate = (date, reportDates) => (
  typeof date === 'string'
  && DATE_ONLY_PATTERN.test(date)
  && reportDates.slice(1).includes(date)
);

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const getDiningType = (order) => order.diningType || order.items?.[0]?.diningType || 'non_ac';
const getNetSales = (order) => Math.max(
  0,
  Number(order.subtotal || 0) - Number(order.discountAmount || 0)
);
const getRefundAmount = (order) => Math.min(
  Number(order.totalAmount || 0),
  Number(order.refundedAmount || (order.paymentStatus === 'refunded' ? order.totalAmount : 0))
);
const getPaidAmountRatio = (order) => {
  if (order.status === 'cancelled'
    || !['paid', 'partially_paid', 'refunded'].includes(order.paymentStatus)) return 0;
  const totalAmount = Number(order.totalAmount || 0);
  if (totalAmount <= 0) return 0;
  const paidAmount = Number(order.paidAmount)
    || (['paid', 'refunded'].includes(order.paymentStatus) ? totalAmount : 0);
  return Math.min(1, Math.max(0, paidAmount - getRefundAmount(order)) / totalAmount);
};

const getCompletedSales = (order) => order.status !== 'cancelled'
  && (order.status === 'served'
    || ['paid', 'transferred_to_folio', 'partially_paid', 'refunded'].includes(order.paymentStatus));

const makeDailyData = (date) => ({
  date,
  summary: {
    totalSales: 0,
    salesBeforeTax: 0,
    originalSales: 0,
    totalDiscount: 0,
    taxAmount: 0,
    totalBills: 0,
    completedBills: 0,
    totalFoodCost: 0,
    paidSales: 0,
    paidFoodCost: 0,
    costedPaidItemCount: 0,
    totalWastage: 0,
    grossProfit: null,
    grossProfitStatus: 'no_paid_sales',
    foodCostStatus: 'complete',
    uncostedSalesCount: 0,
    acSales: 0,
    nonAcSales: 0
  },
  bills: [],
  paymentMethodBreakdown: {},
  rawMaterialConsumption: [],
  wastageDetails: []
});

export const getRestaurantBillingHistory = async (req, res, next) => {
  try {
    const { hotelId, propertyId, timeZone, todayDate, reportDates } = await getBillingReportScope(req);
    const ranges = new Map(reportDates.map((date) => [date, getDayRange(date, timeZone)]));
    if ([...ranges.values()].some((range) => !range)) {
      return res.status(400).json({ success: false, message: 'A valid hotel timezone is required for daily reports.' });
    }

    const selectedDate = req.query.date;
    if (selectedDate !== undefined
      && (typeof selectedDate !== 'string'
        || !DATE_ONLY_PATTERN.test(selectedDate)
        || !reportDates.includes(selectedDate))) {
      return res.status(400).json({
        success: false,
        message: 'Select today or one of the previous five hotel-local calendar days.'
      });
    }

    const overallStart = ranges.get(reportDates[5]).start;
    const overallEnd = ranges.get(todayDate).end;
    const propertyObjectId = new mongoose.Types.ObjectId(propertyId);
    const scope = { hotelId, propertyId: propertyObjectId };

    const [reportOrders, consumptions, unrecordedConsumption, stockWastage, preparedWastage, preparedSales, restaurantInvoices] = await Promise.all([
      FoodOrder.find({
        ...scope,
        $or: [
          { createdAt: { $gte: overallStart, $lt: overallEnd } },
          { paidAt: { $gte: overallStart, $lt: overallEnd } },
          { transferredAt: { $gte: overallStart, $lt: overallEnd } },
          { refundedAt: { $gte: overallStart, $lt: overallEnd } }
        ]
      })
        .populate('tableId', 'tableNumber name')
        .sort({ createdAt: -1 })
        .lean(),
      RecipeConsumption.find({
        ...scope,
        status: 'deducted',
        deductedAt: { $gte: overallStart, $lt: overallEnd }
      }).lean(),
      StockMovement.find({
        ...scope,
        movementType: 'issue',
        'metadata.source': 'stock_verification_unrecorded_consumption',
        department: { $in: ['Kitchen', 'Restaurant', 'Production'] },
        transactionDate: { $gte: overallStart, $lt: overallEnd }
      }).populate('itemId', 'name unit baseUnit').lean(),
      StockMovement.find({
        ...scope,
        movementType: { $in: ['wastage', 'expiry'] },
        transactionDate: { $gte: overallStart, $lt: overallEnd },
        $or: [
          { department: { $in: ['Kitchen', 'Restaurant', 'Production'] } },
          { sourceDepartment: { $in: ['Kitchen', 'Restaurant', 'Production'] } },
          { 'metadata.source': 'food_production' }
        ]
      }).populate('itemId', 'name unit baseUnit').lean(),
      PreparedFoodMovement.find({
        ...scope,
        movementType: 'wastage',
        createdAt: { $gte: overallStart, $lt: overallEnd }
      }).populate('menuItemId', 'name').lean(),
      PreparedFoodMovement.find({
        ...scope,
        movementType: 'sale',
        createdAt: { $gte: overallStart, $lt: overallEnd }
      }).populate('menuItemId', 'name').lean(),
      Invoice.find({
        hotelId,
        propertyId: propertyObjectId,
        'items.itemType': 'restaurant',
        'items.sourceRef': { $exists: true, $ne: '' }
      }).select('invoiceNumber totalAmount items').lean()
    ]);

    const invoiceOrderMap = new Map();
    for (const invoice of restaurantInvoices) {
      for (const item of invoice.items || []) {
        if (item.itemType !== 'restaurant' || !mongoose.isValidObjectId(item.sourceRef)) continue;
        const orderId = String(item.sourceRef);
        const amount = Number(item.amount || 0);
        const entry = invoiceOrderMap.get(orderId) || { amount: 0, invoiceIds: new Set() };
        entry.amount += amount;
        entry.invoiceIds.add(String(invoice._id));
        invoiceOrderMap.set(orderId, entry);
      }
    }

    const invoiceIds = restaurantInvoices.map((invoice) => invoice._id);
    const [payments, refunds] = invoiceIds.length ? await Promise.all([
      Payment.find({
        hotelId,
        invoiceId: { $in: invoiceIds },
        status: 'captured',
        paymentDate: { $gte: overallStart, $lt: overallEnd }
      }).lean(),
      Refund.find({
        hotelId,
        invoiceId: { $in: invoiceIds },
        status: 'processed',
        createdAt: { $gte: overallStart, $lt: overallEnd }
      }).populate('paymentId', 'method').lean()
    ]) : [[], []];
    const invoiceSourceOrderIds = restaurantInvoices.flatMap((invoice) => (invoice.items || [])
      .filter((item) => item.itemType === 'restaurant' && mongoose.isValidObjectId(item.sourceRef))
      .map((item) => String(item.sourceRef)));
    const relatedOrders = invoiceSourceOrderIds.length ? await FoodOrder.find({
      _id: { $in: invoiceSourceOrderIds },
      hotelId,
      propertyId: propertyObjectId
    }).lean() : [];

    const dailyByDate = new Map(reportDates.map((date) => [date, makeDailyData(date)]));
    const getEventDate = (date) => getHotelLocalDate(timeZone, new Date(date));
    const billOrders = reportOrders.filter((order) => (
      new Date(order.createdAt) >= overallStart && new Date(order.createdAt) < overallEnd
    ));
    const reportOrderIds = reportOrders.map((order) => order._id);
    const legacyRecipeMovements = reportOrderIds.length ? await StockMovement.find({
      ...scope,
      orderId: { $in: reportOrderIds },
      movementType: 'recipe_consumption',
      transactionDate: { $gte: overallStart, $lt: overallEnd }
    }).populate('itemId', 'name unit baseUnit').lean() : [];

    for (const order of billOrders) {
      const date = getEventDate(order.createdAt);
      const daily = dailyByDate.get(date);
      if (!daily) continue;

      const diningType = getDiningType(order);
      const netSales = getNetSales(order);
      const invoiceDetails = invoiceOrderMap.get(String(order._id));
      const orderDocument = {
        ...order,
        diningType,
        refundAmount: Number(order.refundedAmount || 0),
        restaurantFolioAmount: invoiceDetails?.amount || 0
      };
      daily.bills.push(orderDocument);
      daily.summary.totalBills += 1;

      if (getCompletedSales(order)) {
        daily.summary.completedBills += 1;
        const totalAmount = Number(order.totalAmount || 0);
        daily.summary.totalSales += totalAmount;
        daily.summary.salesBeforeTax += netSales;
        daily.summary.originalSales += Number(order.subtotal || 0);
        daily.summary.totalDiscount += Number(order.discountAmount || 0);
        daily.summary.taxAmount += Number(order.taxAmount || 0);
        daily.summary[diningType === 'ac' ? 'acSales' : 'nonAcSales'] += totalAmount;
      }
    }

    const invoiceMap = new Map(restaurantInvoices.map((invoice) => [String(invoice._id), invoice]));
    const salesOrdersById = new Map([
      ...reportOrders.map((order) => [String(order._id), order]),
      ...relatedOrders.map((order) => [String(order._id), order])
    ]);
    const consumptionByOrderId = new Map(
      consumptions.map((consumption) => [String(consumption.orderId), consumption])
    );
    const recipeCostByOrderAndMenuItem = new Map();
    const addRecipeCost = (orderId, menuItemId, cost) => {
      if (!menuItemId) return;
      const key = `${orderId}:${String(menuItemId)}`;
      recipeCostByOrderAndMenuItem.set(
        key,
        roundMoney((recipeCostByOrderAndMenuItem.get(key) || 0) + Number(cost || 0))
      );
    };
    for (const consumption of consumptions) {
      for (const ingredient of consumption.ingredients || []) {
        addRecipeCost(consumption.orderId, ingredient.menuItemId, ingredient.totalCost);
      }
    }
    const legacyMovementsByOrderId = new Map();
    for (const movement of legacyRecipeMovements) {
      const orderId = String(movement.orderId);
      if (consumptionByOrderId.has(orderId)) continue;
      const orderMovements = legacyMovementsByOrderId.get(orderId) || [];
      orderMovements.push(movement);
      legacyMovementsByOrderId.set(orderId, orderMovements);
      const recipeSources = (movement.metadata?.recipeSources || [])
        .filter((source) => source.menuItemId);
      const sourceQuantityTotal = recipeSources.reduce(
        (sum, source) => sum + Math.max(0, Number(source.quantity || 0)),
        0
      );
      if (recipeSources.length > 0) {
        let allocatedCost = 0;
        recipeSources.forEach((source, index) => {
          const cost = index === recipeSources.length - 1
            ? Number(movement.totalValue || 0) - allocatedCost
            : Number(movement.totalValue || 0)
              * (sourceQuantityTotal > 0
                ? Math.max(0, Number(source.quantity || 0)) / sourceQuantityTotal
                : 1 / recipeSources.length);
          allocatedCost += cost;
          addRecipeCost(orderId, source.menuItemId, cost);
        });
      }
    }
    const preparedSalesByOrderId = new Map();
    for (const movement of preparedSales) {
      const orderId = String(movement.orderId || '');
      if (!orderId) continue;
      const movements = preparedSalesByOrderId.get(orderId) || [];
      movements.push(movement);
      preparedSalesByOrderId.set(orderId, movements);
      if (Number.isInteger(movement.orderLineIndex)) {
        const order = salesOrdersById.get(orderId);
        const line = order?.items?.[movement.orderLineIndex];
        if (line) addRecipeCost(orderId, line.menuItemId, movement.totalCost);
      }
    }

    for (const order of reportOrders) {
      if (!getCompletedSales(order)) continue;
      const diningType = getDiningType(order);
      const grossAmount = Number(order.totalAmount || 0);
      const netAmount = getNetSales(order);
      const directRefund = getRefundAmount(order);
      const refundDate = getEventDate(order.refundedAt || order.createdAt);
      const refundDay = dailyByDate.get(refundDate);
      if (refundDay && directRefund > 0) {
        const refundRatio = grossAmount > 0 ? directRefund / grossAmount : 0;
        const netRefund = netAmount * refundRatio;
        const originalRefund = Number(order.subtotal || 0) * refundRatio;
        refundDay.summary.totalSales -= directRefund;
        refundDay.summary.salesBeforeTax -= netRefund;
        refundDay.summary.originalSales -= originalRefund;
        refundDay.summary.totalDiscount -= Number(order.discountAmount || 0) * refundRatio;
        refundDay.summary.taxAmount -= Number(order.taxAmount || 0) * refundRatio;
        refundDay.summary[diningType === 'ac' ? 'acSales' : 'nonAcSales'] -= directRefund;
      }

      const paidAt = order.paidAt || order.createdAt;
      const method = order.paymentMethod;
      const paymentDay = method && ['paid', 'partially_paid', 'refunded'].includes(order.paymentStatus)
        ? dailyByDate.get(getEventDate(paidAt))
        : null;
      if (paymentDay) {
        let paidAmount = Number(order.paidAmount || 0);
        if (!paidAmount && ['paid', 'refunded'].includes(order.paymentStatus)) paidAmount = grossAmount;
        paymentDay.paymentMethodBreakdown[method] = roundMoney(
          (paymentDay.paymentMethodBreakdown[method] || 0) + paidAmount
        );
      }
      if (method && directRefund > 0 && refundDay) {
        refundDay.paymentMethodBreakdown[method] = roundMoney(
          (refundDay.paymentMethodBreakdown[method] || 0) - directRefund
        );
      }
    }
    const allocateInvoiceAmount = (invoiceId, amount) => {
      const invoice = invoiceMap.get(String(invoiceId));
      if (!invoice || !(Number(invoice.totalAmount) > 0)) return [];
      const restaurantItems = (invoice.items || []).filter((item) => (
        item.itemType === 'restaurant' && mongoose.isValidObjectId(item.sourceRef)
      ));
      const restaurantTotal = restaurantItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      if (!restaurantTotal) return [];
      return restaurantItems.map((item) => ({
        orderId: String(item.sourceRef),
        amount: Number(amount) * (Number(item.amount || 0) / Number(invoice.totalAmount))
      }));
    };

    for (const payment of payments) {
      const daily = dailyByDate.get(getEventDate(payment.paymentDate));
      if (!daily) continue;
      for (const allocation of allocateInvoiceAmount(payment.invoiceId, payment.amount)) {
        const order = salesOrdersById.get(allocation.orderId);
        if (!order) continue;
        const method = payment.method || 'other';
        daily.paymentMethodBreakdown[method] = roundMoney(
          (daily.paymentMethodBreakdown[method] || 0) + allocation.amount
        );
      }
    }

    for (const refund of refunds) {
      const daily = dailyByDate.get(getEventDate(refund.createdAt));
      if (!daily) continue;
      for (const allocation of allocateInvoiceAmount(refund.invoiceId, refund.amount)) {
        const order = salesOrdersById.get(allocation.orderId);
        if (!order || !getCompletedSales(order)) continue;
        const grossOrderAmount = Number(order.totalAmount || 0);
        const netOrderAmount = getNetSales(order);
        const refundRatio = grossOrderAmount > 0 ? allocation.amount / grossOrderAmount : 0;
        const netRefund = netOrderAmount * refundRatio;
        const diningType = getDiningType(order);
        daily.summary.totalSales -= allocation.amount;
        daily.summary.salesBeforeTax -= netRefund;
        daily.summary.originalSales -= Number(order.subtotal || 0) * refundRatio;
        daily.summary.totalDiscount -= Number(order.discountAmount || 0) * refundRatio;
        daily.summary.taxAmount -= Number(order.taxAmount || 0) * refundRatio;
        daily.summary[diningType === 'ac' ? 'acSales' : 'nonAcSales'] -= allocation.amount;
        const method = refund.paymentId?.method;
        if (method) {
          daily.paymentMethodBreakdown[method] = roundMoney(
            (daily.paymentMethodBreakdown[method] || 0) - allocation.amount
          );
        }
      }
    }

    for (const consumption of consumptions) {
      const daily = dailyByDate.get(getEventDate(consumption.deductedAt));
      if (!daily) continue;
      daily.summary.totalFoodCost += Number(consumption.totalCost || 0);
      for (const ingredient of consumption.ingredients || []) {
        daily.rawMaterialConsumption.push({
          date: daily.date,
          itemName: ingredient.itemNameSnapshot || ingredient.itemName || 'Raw material',
          quantity: Number(ingredient.quantity || 0),
          unit: ingredient.baseUnit || ingredient.unit || '',
          totalCost: Number(ingredient.totalCost || 0),
          source: 'restaurant_order',
          reference: consumption.orderNumber
        });
      }
    }

    for (const [orderId, movements] of legacyMovementsByOrderId) {
      const order = salesOrdersById.get(orderId);
      if (!order || !getCompletedSales(order)) continue;
      const daily = dailyByDate.get(getEventDate(movements[0].transactionDate));
      if (!daily) continue;
      for (const movement of movements) {
        const cost = Number(movement.totalValue || 0);
        daily.summary.totalFoodCost += cost;
        daily.rawMaterialConsumption.push({
          date: daily.date,
          itemName: movement.itemId?.name || 'Raw material',
          quantity: Math.abs(Number(movement.quantity || 0)),
          unit: movement.itemId?.baseUnit || movement.itemId?.unit || movement.baseUnit || '',
          totalCost: cost,
          source: 'restaurant_order',
          reference: order.orderNumber
        });
      }
    }

    for (const movement of preparedSales) {
      const daily = dailyByDate.get(getEventDate(movement.createdAt));
      if (!daily) continue;
      const cost = Number(movement.totalCost || 0);
      daily.summary.totalFoodCost += cost;
      daily.rawMaterialConsumption.push({
        date: daily.date,
        itemName: movement.menuItemId?.name || 'Prepared food',
        quantity: Number(movement.quantity || 0),
        unit: 'portions',
        totalCost: cost,
        source: 'prepared_food_sale',
        reference: movement.orderNumber || ''
      });
    }

    for (const movement of unrecordedConsumption) {
      const daily = dailyByDate.get(getEventDate(movement.transactionDate));
      if (!daily) continue;
      const cost = Number(movement.totalValue || 0);
      daily.summary.totalFoodCost += cost;
      daily.rawMaterialConsumption.push({
        date: daily.date,
        itemName: movement.itemId?.name || 'Raw material',
        quantity: Math.abs(Number(movement.quantity || 0)),
        unit: movement.itemId?.baseUnit || movement.itemId?.unit || movement.baseUnit || '',
        totalCost: cost,
        source: 'stock_verification_unrecorded_consumption',
        department: movement.department,
        reason: movement.notes || 'Unrecorded consumption from stock verification',
        reference: movement.referenceNumber
      });
    }

    for (const movement of stockWastage) {
      const daily = dailyByDate.get(getEventDate(movement.transactionDate));
      if (!daily) continue;
      const cost = Number(movement.totalValue || 0);
      daily.summary.totalWastage += cost;
      daily.wastageDetails.push({
        date: daily.date,
        itemName: movement.itemId?.name || 'Raw material',
        quantity: Math.abs(Number(movement.quantity || 0)),
        unit: movement.itemId?.baseUnit || movement.itemId?.unit || movement.baseUnit || '',
        totalCost: cost,
        reason: movement.notes || movement.metadata?.reason || movement.movementType,
        department: movement.department || movement.sourceDepartment || '',
        reference: movement.referenceNumber
      });
    }

    for (const movement of preparedWastage) {
      const daily = dailyByDate.get(getEventDate(movement.createdAt));
      if (!daily) continue;
      const cost = Number(movement.totalCost || 0);
      daily.summary.totalWastage += cost;
      daily.wastageDetails.push({
        date: daily.date,
        itemName: movement.menuItemId?.name || 'Prepared food',
        quantity: Number(movement.quantity || 0),
        unit: 'portions',
        totalCost: cost,
        reason: movement.reason || 'Prepared food wastage',
        reference: movement.orderNumber || ''
      });
    }

    for (const daily of dailyByDate.values()) {
      const summary = daily.summary;
      summary.totalSales = roundMoney(summary.totalSales);
      summary.salesBeforeTax = roundMoney(summary.salesBeforeTax);
      summary.originalSales = roundMoney(summary.originalSales);
      summary.totalDiscount = roundMoney(summary.totalDiscount);
      summary.taxAmount = roundMoney(summary.taxAmount);
      summary.acSales = roundMoney(summary.acSales);
      summary.nonAcSales = roundMoney(summary.nonAcSales);
      summary.totalFoodCost = roundMoney(summary.totalFoodCost);
      summary.totalWastage = roundMoney(summary.totalWastage);
      const dayOrders = billOrders.filter((order) => getEventDate(order.createdAt) === daily.date);
      for (const order of dayOrders) {
        const paidRatio = getPaidAmountRatio(order);
        if (paidRatio <= 0) continue;
        const items = order.items || [];
        const lineSubtotals = items.map((line) => Number(line.amount || 0));
        const orderSubtotal = Number(order.subtotal || 0)
          || lineSubtotals.reduce((sum, amount) => sum + amount, 0);
        const menuItemLineQuantities = new Map();
        for (const line of items) {
          const menuItemId = String(line.menuItemId);
          menuItemLineQuantities.set(
            menuItemId,
            (menuItemLineQuantities.get(menuItemId) || 0) + Number(line.quantity || 0)
          );
        }
        const consumption = consumptionByOrderId.get(String(order._id));
        const preparedLineCosts = new Map();
        for (const movement of preparedSalesByOrderId.get(String(order._id)) || []) {
          if (!Number.isInteger(movement.orderLineIndex)) continue;
          const lineIndex = Number(movement.orderLineIndex);
          preparedLineCosts.set(
            lineIndex,
            (preparedLineCosts.get(lineIndex) || 0) + Number(movement.totalCost || 0)
          );
        }
        const orderRecipeCost = new Map();
        for (const ingredient of consumption?.ingredients || []) {
          const menuItemId = String(ingredient.menuItemId);
          orderRecipeCost.set(
            menuItemId,
            (orderRecipeCost.get(menuItemId) || 0) + Number(ingredient.totalCost || 0)
          );
        }
        for (const movement of legacyMovementsByOrderId.get(String(order._id)) || []) {
          for (const source of movement.metadata?.recipeSources || []) {
            if (!source.menuItemId) continue;
            const menuItemId = String(source.menuItemId);
            orderRecipeCost.set(
              menuItemId,
              recipeCostByOrderAndMenuItem.get(`${String(order._id)}:${menuItemId}`) || 0
            );
          }
        }
        for (const [lineIndex, line] of items.entries()) {
          const menuItemId = String(line.menuItemId);
          const menuItemQuantity = menuItemLineQuantities.get(menuItemId) || 0;
          const itemSubtotal = lineSubtotals[lineIndex]
            || Number(line.quantity || 0) * Number(line.unitPriceSnapshot ?? line.unitPrice ?? 0);
          const paidItemSales = orderSubtotal > 0
            ? Number(order.totalAmount || 0) * (itemSubtotal / orderSubtotal) * paidRatio
            : 0;
          const hasPreparedCost = preparedLineCosts.has(lineIndex);
          const hasRecipeCost = orderRecipeCost.has(menuItemId)
            || recipeCostByOrderAndMenuItem.has(`${String(order._id)}:${menuItemId}`);
          const fullLineCost = hasPreparedCost
            ? preparedLineCosts.get(lineIndex)
            : hasRecipeCost
              ? (orderRecipeCost.get(menuItemId)
                ?? recipeCostByOrderAndMenuItem.get(`${String(order._id)}:${menuItemId}`) ?? 0)
                * (menuItemQuantity > 0 ? Number(line.quantity || 0) / menuItemQuantity : 1)
              : null;
          if (fullLineCost === null) {
            summary.uncostedSalesCount += 1;
            continue;
          }
          summary.paidSales += paidItemSales;
          summary.paidFoodCost += fullLineCost * paidRatio;
          summary.costedPaidItemCount += 1;
        }
      }
      summary.paidSales = roundMoney(summary.paidSales);
      summary.paidFoodCost = roundMoney(summary.paidFoodCost);
      summary.foodCostStatus = summary.uncostedSalesCount > 0 ? 'pending' : 'complete';
      summary.grossProfitStatus = summary.costedPaidItemCount === 0
        ? summary.uncostedSalesCount > 0 ? 'pending' : 'no_paid_sales'
        : summary.uncostedSalesCount > 0 ? 'partial' : 'complete';
      summary.grossProfit = summary.costedPaidItemCount > 0
        ? roundMoney(summary.paidSales - summary.paidFoodCost)
        : summary.uncostedSalesCount > 0 ? null : 0;
    }

    const serializeDaily = (daily) => ({
      ...daily,
      paymentMethodBreakdown: Object.entries(daily.paymentMethodBreakdown)
        .map(([method, amount]) => ({ method, amount }))
        .sort((left, right) => left.method.localeCompare(right.method))
    });
    const allDays = reportDates.map((date) => serializeDaily(dailyByDate.get(date)));
    const visibilityRecords = await RestaurantBillingReportVisibility.find({
      hotelId,
      propertyId: propertyObjectId,
      reportDate: { $in: reportDates.slice(1) },
      isHidden: true
    })
      .populate('restoreRequests.requestedBy restoreRequests.reviewedBy', 'name email')
      .lean();
    const hiddenReportByDate = new Map(visibilityRecords.map((record) => [record.reportDate, record]));
    const hiddenReports = visibilityRecords.map((record) => {
      const latestRequest = record.restoreRequests?.[record.restoreRequests.length - 1];
      return {
        date: record.reportDate,
        hiddenAt: record.hiddenAt,
        restoreRequest: latestRequest || null
      };
    }).sort((left, right) => right.date.localeCompare(left.date));
    const pendingRestoreRequests = req.user?.role === 'super_admin'
      ? visibilityRecords.flatMap((record) => (record.restoreRequests || [])
        .filter((restoreRequest) => restoreRequest.status === 'pending')
        .map((restoreRequest) => ({
          _id: restoreRequest._id,
          reportDate: record.reportDate,
          reason: restoreRequest.reason,
          requestedAt: restoreRequest.requestedAt,
          requestedBy: restoreRequest.requestedBy
        })))
      : [];

    res.json({
      success: true,
      data: {
        timeZone,
        todayDate,
        today: allDays[0],
        previousDays: allDays.slice(1).filter((day) => !hiddenReportByDate.has(day.date)),
        hiddenReports,
        pendingRestoreRequests,
        selectedDay: selectedDate ? allDays.find((day) => day.date === selectedDate) : null
      }
    });
  } catch (err) {
    next(err);
  }
};

export const hideRestaurantBillingReport = async (req, res, next) => {
  try {
    if (req.user?.role !== 'hotel_admin') {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can hide daily reports.' });
    }
    const { hotelId, propertyId, reportDates } = await getBillingReportScope(req);
    const reportDate = req.params.date;
    if (!isPreviousReportDate(reportDate, reportDates)) {
      return res.status(400).json({ success: false, message: 'Only one of the previous five completed days can be hidden.' });
    }

    const report = await RestaurantBillingReportVisibility.findOneAndUpdate(
      { hotelId, propertyId, reportDate },
      {
        $set: { isHidden: true, hiddenAt: new Date(), hiddenBy: req.user._id },
        $setOnInsert: { hotelId, propertyId, reportDate }
      },
      { new: true, upsert: true, runValidators: true }
    );
    await logAudit({
      hotelId,
      action: 'HIDE_RESTAURANT_BILLING_REPORT',
      entity: 'RestaurantBillingReportVisibility',
      entityId: report._id,
      details: { propertyId: String(propertyId), reportDate },
      req
    });
    res.json({ success: true, data: { reportDate, isHidden: report.isHidden } });
  } catch (error) {
    next(error);
  }
};

export const requestRestaurantBillingReportRestore = async (req, res, next) => {
  try {
    if (req.user?.role !== 'hotel_admin') {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can request report restoration.' });
    }
    const { hotelId, propertyId, reportDates } = await getBillingReportScope(req);
    const reportDate = req.params.date;
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!isPreviousReportDate(reportDate, reportDates)) {
      return res.status(400).json({ success: false, message: 'Only a hidden report from the previous five completed days can be requested.' });
    }
    if (!reason || reason.length > 500) {
      return res.status(400).json({ success: false, message: 'Provide a reason of up to 500 characters for restoring this report.' });
    }

    const report = await RestaurantBillingReportVisibility.findOneAndUpdate({
      hotelId,
      propertyId,
      reportDate,
      isHidden: true,
      restoreRequests: { $not: { $elemMatch: { status: 'pending' } } }
    }, {
      $push: { restoreRequests: { reason, requestedBy: req.user._id } }
    }, { new: true, runValidators: true });
    if (!report) {
      const hiddenReport = await RestaurantBillingReportVisibility.exists({
        hotelId, propertyId, reportDate, isHidden: true
      });
      if (!hiddenReport) {
        return res.status(404).json({ success: false, message: 'The hidden report was not found.' });
      }
      return res.status(409).json({ success: false, message: 'A restore request for this report is already awaiting approval.' });
    }
    const restoreRequest = report.restoreRequests[report.restoreRequests.length - 1];
    await logAudit({
      hotelId,
      action: 'REQUEST_RESTAURANT_BILLING_REPORT_RESTORE',
      entity: 'RestaurantBillingReportVisibility',
      entityId: report._id,
      details: { propertyId: String(propertyId), reportDate, restoreRequestId: String(restoreRequest._id) },
      req
    });
    res.status(201).json({ success: true, data: { reportDate, restoreRequest } });
  } catch (error) {
    next(error);
  }
};

export const reviewRestaurantBillingReportRestore = async (req, res, next) => {
  try {
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Only the product administrator can review report restoration requests.' });
    }
    if (!mongoose.isValidObjectId(req.params.requestId)) {
      return res.status(400).json({ success: false, message: 'Report restore request ID is invalid.' });
    }
    const { hotelId, propertyId } = await getBillingReportScope(req);
    const { decision, reviewNote = '' } = req.body;
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Choose approve or reject for this restore request.' });
    }
    if (typeof reviewNote !== 'string' || reviewNote.length > 500) {
      return res.status(400).json({ success: false, message: 'Review note must be 500 characters or fewer.' });
    }
    const reviewedAt = new Date();
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const report = await RestaurantBillingReportVisibility.findOneAndUpdate({
      hotelId,
      propertyId,
      restoreRequests: {
        $elemMatch: {
          _id: req.params.requestId,
          status: 'pending'
        }
      }
    }, {
      $set: {
        'restoreRequests.$.status': status,
        'restoreRequests.$.reviewedBy': req.user._id,
        'restoreRequests.$.reviewedAt': reviewedAt,
        'restoreRequests.$.reviewNote': reviewNote.trim(),
        ...(decision === 'approve' ? { isHidden: false } : {})
      }
    }, { new: true, runValidators: true });
    if (!report) return res.status(404).json({ success: false, message: 'Pending report restore request not found.' });
    await logAudit({
      hotelId,
      action: decision === 'approve'
        ? 'APPROVE_RESTAURANT_BILLING_REPORT_RESTORE'
        : 'REJECT_RESTAURANT_BILLING_REPORT_RESTORE',
      entity: 'RestaurantBillingReportVisibility',
      entityId: report._id,
      details: { propertyId: String(propertyId), reportDate: report.reportDate, restoreRequestId: req.params.requestId },
      req
    });
    res.json({
      success: true,
      data: { reportDate: report.reportDate, isHidden: report.isHidden, status }
    });
  } catch (error) {
    next(error);
  }
};
