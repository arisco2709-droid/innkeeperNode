import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approvePurchaseInvoice,
  approveSupplierReturn,
  completeSupplierReturn,
  createInvoicePayment,
  createOrderFromRequisition,
  createPurchaseInvoice,
  createPurchaseRequisition,
  createSupplierReturn,
  inspectGoodsReceipt,
  reviewProcurementOrder,
  reviewPurchaseRequisition,
  verifyPurchaseInvoice
} from '../controllers/procurementController.js';
import { receivePurchaseOrderGoods } from '../controllers/inventoryController.js';
import {
  GoodsReceipt,
  InventoryBalance,
  InventoryItem,
  PurchaseInvoice,
  PurchaseRequisition,
  StockMovement,
  SupplierPayment,
  SupplierReturn,
  Vendor
} from '../models/index.js';
import { setup, teardown } from './setup.js';

const hotelId = new mongoose.Types.ObjectId();
const propertyId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();

const requestFor = ({ body = {}, params = {}, query = {} } = {}) => ({
  hotelId,
  propertyId,
  user: { _id: actorId, role: 'hotel_admin', name: 'Procurement Test' },
  body,
  params,
  query,
  headers: {},
  get: () => undefined
});

const invoke = async (controller, req) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  await controller(req, res, (error) => {
    throw error;
  });
  return res;
};

describe('end-to-end procurement workflow', () => {
  beforeAll(async () => setup());
  afterAll(async () => teardown());

  it('keeps uninspected goods out of stock and reconciles inspection, invoice, credit and payment', async () => {
    const item = await InventoryItem.create({
      hotelId,
      propertyId,
      name: 'Procurement test flour',
      code: `PF-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'kg',
      baseUnit: 'kg',
      purchaseUnit: 'kg',
      currentStock: 0,
      minStockThreshold: 0,
      unitCost: 10
    });
    const vendor = await Vendor.create({
      hotelId,
      name: 'Procurement test supplier',
      phone: '5550100',
      outstandingBalance: 0
    });

    const requisitionResponse = await invoke(createPurchaseRequisition, requestFor({
      body: {
        department: 'Kitchen',
        requiredLocation: 'Main Store',
        lines: [{ itemId: String(item._id), quantity: 5 }],
        reason: 'Weekly stock replenishment'
      }
    }));
    expect(requisitionResponse.statusCode).toBe(201);
    const requisition = requisitionResponse.body.data;
    expect(requisition.status).toBe('pending');
    expect(requisition.lines[0].availableQuantity).toBe(0);

    const reviewedRequisition = await invoke(reviewPurchaseRequisition, requestFor({
      params: { id: String(requisition._id) },
      body: { decision: 'approve' }
    }));
    expect(reviewedRequisition.body.data.status).toBe('approved');

    const orderResponse = await invoke(createOrderFromRequisition, requestFor({
      params: { id: String(requisition._id) },
      body: {
        vendorId: String(vendor._id),
        items: [{ itemId: String(item._id), unitCost: 10 }]
      }
    }));
    expect(orderResponse.statusCode).toBe(201);
    const order = orderResponse.body.data;
    expect(order.status).toBe('pending_approval');

    await invoke(reviewProcurementOrder, requestFor({
      params: { id: String(order._id) },
      body: { action: 'approve' }
    }));

    const receiveResponse = await invoke(receivePurchaseOrderGoods, requestFor({
      params: { id: String(order._id) },
      body: {
        location: 'Main Store',
        purchaseDate: new Date(Date.now() - 1000).toISOString(),
        requireInspection: true,
        idempotencyKey: `procurement-grn-${new mongoose.Types.ObjectId()}`,
        items: [{ itemId: String(item._id), receivedQuantity: 5 }]
      }
    }));
    expect(receiveResponse.statusCode).toBe(200);
    const receipt = receiveResponse.body.data.receipt;
    expect(receipt.inspectionStatus).toBe('pending');
    expect(await InventoryBalance.findOne({ hotelId, propertyId, itemId: item._id })).toBeNull();
    expect(await InventoryItem.findById(item._id).then((entry) => entry.currentStock)).toBe(0);

    await invoke(inspectGoodsReceipt, requestFor({
      params: { id: String(receipt._id) },
      body: {
        materialCondition: 'Good',
        freshness: 'Fresh',
        packagingCondition: 'Intact',
        lines: [{ acceptedQuantity: 5, rejectedQuantity: 0, damagedQuantity: 0 }]
      }
    }));
    expect(await InventoryBalance.findOne({ hotelId, propertyId, itemId: item._id }).then((entry) => entry.quantity)).toBe(5);
    expect(await GoodsReceipt.findById(receipt._id).then((entry) => entry.inspectionStatus)).toBe('completed');

    const invoiceResponse = await invoke(createPurchaseInvoice, requestFor({
      body: {
        supplierInvoiceNumber: `INV-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
        invoiceDate: new Date(Date.now() - 1000).toISOString(),
        dueDate: new Date(Date.now() + 86400000).toISOString(),
        taxMode: 'intra_state',
        purchaseOrderId: String(order._id),
        lines: [3, 3].map((quantity) => ({
          itemId: String(item._id),
          goodsReceiptId: String(receipt._id),
          quantity,
          unit: 'kg',
          unitPrice: 10,
          gstRate: 5
        })),
        idempotencyKey: `procurement-invoice-${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(invoiceResponse.statusCode).toBe(201);
    const invoice = invoiceResponse.body.data.invoice;
    expect(invoice.grandTotal).toBe(63);
    expect(invoice.quantityVariance).toBe(true);
    expect(invoice.cgstTotal).toBe(1.5);
    expect(invoice.sgstTotal).toBe(1.5);
    expect(invoice.igstTotal).toBe(0);
    expect(invoice.lines[0]).toMatchObject({ cgstAmount: 0.75, sgstAmount: 0.75, igstAmount: 0 });

    await invoke(verifyPurchaseInvoice, requestFor({
      params: { id: String(invoice._id) },
      body: { notes: 'Duplicate quantity lines explicitly reviewed.', authorizeVariance: true }
    }));
    await invoke(approvePurchaseInvoice, requestFor({ params: { id: String(invoice._id) } }));

    await expect(invoke(createSupplierReturn, requestFor({
      body: {
        goodsReceiptId: String(receipt._id),
        invoiceId: String(invoice._id),
        reason: 'Duplicate line quantities exceed the eligible return amount',
        lines: [3, 3].map((quantity) => ({ itemId: String(item._id), quantity })),
        idempotencyKey: `procurement-invalid-return-${new mongoose.Types.ObjectId()}`
      }
    }))).rejects.toMatchObject({ statusCode: 409 });

    const returnResponse = await invoke(createSupplierReturn, requestFor({
      body: {
        goodsReceiptId: String(receipt._id),
        invoiceId: String(invoice._id),
        reason: 'Damaged after delivery',
        lines: [{ itemId: String(item._id), quantity: 1 }],
        idempotencyKey: `procurement-return-${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(returnResponse.statusCode).toBe(201);
    const supplierReturn = returnResponse.body.data.supplierReturn;
    await invoke(approveSupplierReturn, requestFor({ params: { id: String(supplierReturn._id) } }));
    await invoke(completeSupplierReturn, requestFor({
      params: { id: String(supplierReturn._id) },
      body: { creditNoteNumber: 'CN-TEST-1' }
    }));
    expect(await InventoryBalance.findOne({ hotelId, propertyId, itemId: item._id }).then((entry) => entry.quantity)).toBe(4);
    expect(await PurchaseInvoice.findById(invoice._id).then((entry) => entry.creditAdjusted)).toBe(10);

    const paymentResponse = await invoke(createInvoicePayment, requestFor({
      body: {
        vendorId: String(vendor._id),
        paymentMethod: 'bank_transfer',
        referenceNumber: 'PAY-TEST-1',
        allocations: [{ invoiceId: String(invoice._id), amount: 53 }],
        idempotencyKey: `procurement-payment-${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(paymentResponse.statusCode).toBe(201);
    expect(await PurchaseInvoice.findById(invoice._id).then((entry) => entry.status)).toBe('paid');
    expect(await Vendor.findById(vendor._id).then((entry) => entry.outstandingBalance)).toBe(0);
    expect(await SupplierPayment.countDocuments({ vendorId: vendor._id })).toBe(1);
    expect(await SupplierReturn.findById(supplierReturn._id).then((entry) => entry.status)).toBe('completed');
    expect(await StockMovement.countDocuments({ itemId: item._id, movementType: { $in: ['receipt', 'issue'] } })).toBe(2);
    expect(await PurchaseRequisition.findById(requisition._id).then((entry) => entry.purchaseOrderId.toString())).toBe(order._id.toString());
  });
});
