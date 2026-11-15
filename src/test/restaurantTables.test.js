import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';
import { AuditLog } from '../models/AuditLog.js';
import { FoodOrder } from '../models/FoodOrder.js';
import { StockMovement } from '../models/StockMovement.js';
import mongoose from 'mongoose';

let adminToken = '';
let restaurantToken = '';
let superAdminToken = '';
let hotelId = '';
let propertyId = '';
let menuItemId = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();

  const [adminLogin, staffLogin, superAdminLogin] = await Promise.all([
    request(app).post('/api/v1/auth/login').send({
      email: 'admin@grandregal.com',
      password: 'HotelPassword123!'
    }),
    request(app).post('/api/v1/auth/login').send({
      email: 'chef@grandregal.com',
      password: 'StaffPassword123!'
    }),
    request(app).post('/api/v1/auth/login').send({
      email: 'superadmin@grandstayhms.com',
      password: 'AdminPassword123!'
    })
  ]);
  adminToken = adminLogin.body.data.accessToken;
  restaurantToken = staffLogin.body.data.accessToken;
  superAdminToken = superAdminLogin.body.data.accessToken;
  hotelId = staffLogin.body.data.user.hotelId;
  propertyId = staffLogin.body.data.user.propertyId;

  const menu = await request(app)
    .get('/api/v1/restaurant/menu')
      .set('Authorization', ['Bearer', adminToken].join(' '));
  menuItemId = menu.body.data.items[0]._id;
});

afterAll(async () => {
  await teardown();
});

describe('Restaurant table management and POS assignment', () => {
  it('hides previous daily reports without deleting data and restores them only after product-admin approval', async () => {
    const reportPath = '/api/v1/restaurant/billing-history';
    const reportResponse = await request(app)
      .get(reportPath)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const reportDate = reportResponse.body.data.previousDays[0].date;
    const billsBefore = await FoodOrder.countDocuments({ hotelId, propertyId });

    await request(app)
      .post(`${reportPath}/${reportDate}/hide`)
      .set('Authorization', ['Bearer', restaurantToken].join(' '))
      .expect(403);
    await request(app)
      .post(`${reportPath}/${reportDate}/hide`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const hiddenReportResponse = await request(app)
      .get(reportPath)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    expect(hiddenReportResponse.body.data.previousDays.some((day) => day.date === reportDate)).toBe(false);
    expect(hiddenReportResponse.body.data.hiddenReports[0]).toMatchObject({
      date: reportDate,
      restoreRequest: null
    });
    expect(await FoodOrder.countDocuments({ hotelId, propertyId })).toBe(billsBefore);

    await request(app)
      .post(`${reportPath}/${reportDate}/restore-requests`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ reason: 'The report was hidden by mistake.' })
      .expect(201);
    await request(app)
      .post(`${reportPath}/${reportDate}/restore-requests`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ reason: 'Duplicate request.' })
      .expect(409);

    const productAdminReport = await request(app)
      .get(`${reportPath}?propertyId=${propertyId}`)
      .set('Authorization', ['Bearer', superAdminToken].join(' '))
      .set('x-hotel-id', hotelId)
      .expect(200);
    const restoreRequest = productAdminReport.body.data.pendingRestoreRequests[0];
    expect(restoreRequest.reportDate).toBe(reportDate);

    await request(app)
      .patch(`${reportPath}/restore-requests/${restoreRequest._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ decision: 'approve' })
      .expect(403);
    await request(app)
      .patch(`${reportPath}/restore-requests/${restoreRequest._id}`)
      .set('Authorization', ['Bearer', superAdminToken].join(' '))
      .set('x-hotel-id', hotelId)
      .query({ propertyId })
      .send({ decision: 'approve' })
      .expect(200);

    const restoredReport = await request(app)
      .get(reportPath)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    expect(restoredReport.body.data.previousDays.some((day) => day.date === reportDate)).toBe(true);
    expect(restoredReport.body.data.hiddenReports.some((entry) => entry.date === reportDate)).toBe(false);
    expect(await FoodOrder.countDocuments({ hotelId, propertyId })).toBe(billsBefore);
  });

  it('persists the menu tax percentage entered by the admin', async () => {
    const menu = await request(app)
      .get('/api/v1/restaurant/menu')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const response = await request(app)
      .post('/api/v1/restaurant/items')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        name: 'Menu tax percentage test item',
        categoryId: menu.body.data.categories[0]._id,
        price: 10,
        taxPercent: 15
      })
      .expect(201);
    expect(response.body.data.taxPercent).toBe(15);

    const legacyFieldUpdate = await request(app)
      .patch(`/api/v1/restaurant/items/${response.body.data._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ taxRate: 12 })
      .expect(200);
    expect(legacyFieldUpdate.body.data.taxPercent).toBe(12);
    expect(legacyFieldUpdate.body.data).not.toHaveProperty('taxRate');

    const listedMenu = await request(app)
      .get('/api/v1/restaurant/menu?includeUnavailable=true')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const listedItem = listedMenu.body.data.items.find((item) => item._id === response.body.data._id);
    expect(listedItem.taxPercent).toBe(12);
  });

  it('uses independent AC and Non-AC prices and preserves order price snapshots', async () => {
    const menu = await request(app)
      .get('/api/v1/restaurant/menu')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const itemResponse = await request(app)
      .post('/api/v1/restaurant/items')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        name: 'Dual price test dish',
        categoryId: menu.body.data.categories[0]._id,
        price: 8,
        nonAcPrice: 8,
        nonAcPricingEnabled: true,
        acPricingEnabled: true,
        acPrice: 12
      });
    expect(itemResponse.status).toBe(201);
    const pricedItem = itemResponse.body.data;
    expect(pricedItem.acPricingEnabled).toBe(true);
    expect(pricedItem.nonAcPricingEnabled).toBe(true);
    const listedPricedItem = await request(app)
      .get('/api/v1/restaurant/menu?includeUnavailable=true')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(listedPricedItem.body.data.items.filter((item) => item._id === pricedItem._id)).toHaveLength(1);

    const reportBefore = await request(app)
      .get('/api/v1/reports/financial')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const acOrderResponse = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'takeaway',
        diningType: 'ac',
        items: [{ menuItemId: pricedItem._id, quantity: 2 }]
      });
    expect(acOrderResponse.status).toBe(201);
    expect(acOrderResponse.body.data.items[0].unitPrice).toBe(12);
    expect(acOrderResponse.body.data.items[0].unitPriceSnapshot).toBe(12);
    expect(acOrderResponse.body.data.items[0].diningType).toBe('ac');
    expect(acOrderResponse.body.data.taxAmount).toBe(1.2);
    expect(acOrderResponse.body.data.totalAmount).toBe(25.2);

    const updatedMenuItem = await request(app)
      .patch(`/api/v1/restaurant/items/${pricedItem._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ acPrice: 15, nonAcPrice: 9 });
    expect(updatedMenuItem.status).toBe(200);
    expect(updatedMenuItem.body.data.price).toBe(9);

    const nonAcOrderResponse = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'takeaway',
        diningType: 'non_ac',
        items: [{ menuItemId: pricedItem._id, quantity: 3 }]
      });
    expect(nonAcOrderResponse.status).toBe(201);
    expect(nonAcOrderResponse.body.data.items[0].unitPrice).toBe(9);
    expect(nonAcOrderResponse.body.data.items[0].diningType).toBe('non_ac');
    expect(nonAcOrderResponse.body.data.taxAmount).toBe(1.35);
    expect(nonAcOrderResponse.body.data.totalAmount).toBe(28.35);

    const persistedAcOrder = await FoodOrder.findById(acOrderResponse.body.data._id).lean();
    expect(persistedAcOrder.items[0].unitPrice).toBe(12);
    expect(persistedAcOrder.items[0].unitPriceSnapshot).toBe(12);
    expect(persistedAcOrder.subtotal).toBe(24);
    expect(persistedAcOrder.totalAmount).toBe(25.2);

    const reportAfter = await request(app)
      .get('/api/v1/reports/financial')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(reportAfter.body.data.restaurantSales.ac.salesAmount
      - reportBefore.body.data.restaurantSales.ac.salesAmount).toBe(24);
    expect(reportAfter.body.data.restaurantSales.nonAc.salesAmount
      - reportBefore.body.data.restaurantSales.nonAc.salesAmount).toBe(27);

    const disabledNonAc = await request(app)
      .patch(`/api/v1/restaurant/items/${pricedItem._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ nonAcPricingEnabled: false });
    expect(disabledNonAc.status).toBe(200);
    const unavailableNonAcOrder = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'takeaway',
        diningType: 'non_ac',
        items: [{ menuItemId: pricedItem._id, quantity: 1 }]
      });
    expect(unavailableNonAcOrder.status).toBe(400);

    const stillPricedAcOrder = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'takeaway',
        diningType: 'ac',
        items: [{ menuItemId: pricedItem._id, quantity: 1 }]
      });
    expect(stillPricedAcOrder.status).toBe(201);
    await request(app)
      .patch(`/api/v1/restaurant/items/${pricedItem._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ acPricingEnabled: false });
    const unavailableAcOrder = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'takeaway',
        diningType: 'ac',
        items: [{ menuItemId: pricedItem._id, quantity: 1 }]
      });
    expect(unavailableAcOrder.status).toBe(400);
  });

  it('keeps unavailable items visible to admins while excluding them from POS menus', async () => {
    const unavailable = await request(app)
      .patch(`/api/v1/restaurant/items/${menuItemId}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ isAvailable: false });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.data.isAvailable).toBe(false);

    const managementMenu = await request(app)
      .get('/api/v1/restaurant/menu?includeUnavailable=true')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(managementMenu.status).toBe(200);
    expect(managementMenu.body.data.items.find((item) => item._id === menuItemId)?.isAvailable).toBe(false);

    const posMenu = await request(app)
      .get('/api/v1/restaurant/menu')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(posMenu.body.data.items.some((item) => item._id === menuItemId)).toBe(false);

    const forbiddenManagementMenu = await request(app)
      .get('/api/v1/restaurant/menu?includeUnavailable=true')
      .set('Authorization', ['Bearer', restaurantToken].join(' '));
    expect(forbiddenManagementMenu.status).toBe(403);

    const restored = await request(app)
      .patch(`/api/v1/restaurant/items/${menuItemId}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ isAvailable: true });
    expect(restored.status).toBe(200);
    expect(restored.body.data.isAvailable).toBe(true);

    const availableAgain = await request(app)
      .get('/api/v1/restaurant/menu')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(availableAgain.body.data.items.some((item) => item._id === menuItemId)).toBe(true);
  });

  it('creates sequential tables and restricts table management to hotel admins', async () => {
    const first = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ capacity: 4, name: 'Window' });
    const second = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ capacity: 2, diningType: 'ac' });

    expect(first.status).toBe(201);
    expect(first.body.data.tableNumber).toBe(1);
    expect(first.body.data.propertyId).toBe(propertyId);
    expect(second.status).toBe(201);
    expect(second.body.data.tableNumber).toBe(2);
    expect(first.body.data.diningType).toBe('non_ac');
    expect(second.body.data.diningType).toBe('ac');

    const menu = await request(app)
      .get('/api/v1/restaurant/menu')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const acMenuItem = await request(app)
      .post('/api/v1/restaurant/items')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        name: 'AC table pricing test',
        categoryId: menu.body.data.categories[0]._id,
        price: 7,
        nonAcPrice: 7,
        nonAcPricingEnabled: true,
        acPricingEnabled: true,
        acPrice: 11
      });
    const acTableOrder = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'dine_in',
        tableId: second.body.data._id,
        diningType: 'non_ac',
        items: [{ menuItemId: acMenuItem.body.data._id, quantity: 1 }]
      });
    expect(acTableOrder.status).toBe(201);
    expect(acTableOrder.body.data.diningType).toBe('ac');
    expect(acTableOrder.body.data.items[0].unitPrice).toBe(11);
    await request(app)
      .patch(`/api/v1/restaurant/orders/${acTableOrder.body.data._id}/status`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ status: 'cancelled' });
    await request(app)
      .patch(`/api/v1/restaurant/tables/${second.body.data._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ diningType: 'non_ac' });

    const forbiddenCreate = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', restaurantToken].join(' '))
      .send({ capacity: 4 });
    expect(forbiddenCreate.status).toBe(403);

    const staffTables = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', restaurantToken].join(' '));
    expect(staffTables.status).toBe(200);
    expect(staffTables.body.data).toHaveLength(2);
    expect(staffTables.body.data[0].currentStatus).toBe('available');
  });

  it('atomically assigns one table, preserves its snapshot, and releases only after settlement', async () => {
    const tablesRes = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const table = tablesRes.body.data[0];
    const orderPayload = {
      orderType: 'dine_in',
      tableId: table._id,
      items: [{ menuItemId, quantity: 1 }]
    };

    const results = await Promise.all([
      request(app)
        .post('/api/v1/restaurant/orders')
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send(orderPayload),
      request(app)
        .post('/api/v1/restaurant/orders')
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send(orderPayload)
    ]);

    const created = results.find((result) => result.status === 201);
    const conflict = results.find((result) => result.status === 409);
    const appended = results.find((result) => result.status === 200);
    expect(created).toBeTruthy();
    expect(conflict || appended).toBeTruthy();
    if (appended) {
      expect(appended.body.data._id).toBe(created.body.data._id);
      expect(appended.body.data.items).toHaveLength(2);
    }
    const order = created.body.data;
    expect(order.tableId).toBe(table._id);
    expect(order.tableNumber).toBe('Table 1');

    const occupiedTables = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(occupiedTables.body.data.find((entry) => entry._id === table._id).currentStatus).toBe('occupied');

    const rename = await request(app)
      .patch(`/api/v1/restaurant/tables/${table._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ name: 'Garden' });
    expect(rename.status).toBe(200);
    const cannotChangeDiningType = await request(app)
      .patch(`/api/v1/restaurant/tables/${table._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ diningType: 'ac' });
    expect(cannotChangeDiningType.status).toBe(404);

    const cannotDeactivate = await request(app)
      .patch(`/api/v1/restaurant/tables/${table._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ isActive: false });
    expect(cannotDeactivate.status).toBe(404);

    const orders = await request(app)
      .get('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const kitchenOrder = orders.body.data.find((entry) => entry._id === order._id);
    expect(kitchenOrder.tableNumber).toBe('Table 1');
    expect(kitchenOrder.tableNameSnapshot).toBe('Window');
    expect(kitchenOrder.tableId.name).toBe('Garden');

    const modifiedUnitPrice = await request(app)
      .patch(`/api/v1/restaurant/orders/${order._id}/bill-amounts`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ itemUnitPrices: { 0: 10.25 }, discountAmount: 1, reason: 'Manager approved menu correction' });
    expect(modifiedUnitPrice.status).toBe(200);
    expect(modifiedUnitPrice.body.data.items[0].unitPrice).toBe(10.25);
    expect(modifiedUnitPrice.body.data.discountAmount).toBe(1);
    expect(modifiedUnitPrice.body.data.amountModifications).toHaveLength(2);
    expect(modifiedUnitPrice.body.data.amountModifications[0].reason).toBe('Manager approved menu correction');
    const audit = await AuditLog.findOne({ action: 'UPDATE_RESTAURANT_BILL_AMOUNTS', entityId: order._id });
    expect(audit.details.modifications).toHaveLength(2);

    const persistedBill = await request(app)
      .get('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(persistedBill.body.data.find((entry) => entry._id === order._id).amountModifications).toHaveLength(2);

    for (const status of ['preparing', 'ready', 'served']) {
      const updated = await request(app)
        .patch(`/api/v1/restaurant/orders/${order._id}/status`)
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send({ status });
      expect(updated.status).toBe(200);
    }

    const stillOccupied = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(stillOccupied.body.data.find((entry) => entry._id === table._id).currentStatus).toBe('occupied');

    const settled = await request(app)
      .patch(`/api/v1/restaurant/orders/${order._id}/settle`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ paymentMethod: 'cash' });
    expect(settled.status).toBe(200);
    expect(settled.body.data.paymentStatus).toBe('paid');

    const blockedPaidEdit = await request(app)
      .patch(`/api/v1/restaurant/orders/${order._id}/bill-amounts`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ itemUnitPrices: { 0: 9 }, discountAmount: 0, reason: 'Attempt after payment' });
    expect(blockedPaidEdit.status).toBe(409);

    const availableTables = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(availableTables.body.data.find((entry) => entry._id === table._id).currentStatus).toBe('available');

    const deactivated = await request(app)
      .patch(`/api/v1/restaurant/tables/${table._id}`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ isActive: false });
    expect(deactivated.status).toBe(200);

    const historicalOrder = await request(app)
      .get('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(historicalOrder.body.data.find((entry) => entry._id === order._id).tableNumber).toBe('Table 1');
  });

  it('releases a table when its dine-in order is cancelled', async () => {
    const tablesRes = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const table = tablesRes.body.data.find((entry) => entry.tableNumber === 2);

    const invalidOrder = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'dine_in',
        tableId: table._id,
        items: [{ menuItemId: '000000000000000000000000', quantity: 1 }]
      });
    expect(invalidOrder.status).toBe(400);

    for (const precedingStatuses of [[], ['preparing'], ['preparing', 'ready']]) {
      const created = await request(app)
        .post('/api/v1/restaurant/orders')
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send({
          orderType: 'dine_in',
          tableId: table._id,
          items: [{ menuItemId, quantity: 1 }]
        });
      expect(created.status).toBe(201);

      for (const status of precedingStatuses) {
        const updated = await request(app)
          .patch(`/api/v1/restaurant/orders/${created.body.data._id}/status`)
          .set('Authorization', ['Bearer', adminToken].join(' '))
          .send({ status });
        expect(updated.status).toBe(200);
      }

      const cancelled = await request(app)
        .patch(`/api/v1/restaurant/orders/${created.body.data._id}/status`)
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send({ status: 'cancelled' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data.status).toBe('cancelled');
    }

    const afterCancellation = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    expect(afterCancellation.body.data.find((entry) => entry._id === table._id).currentStatus).toBe('available');
  });

  it('adds further rounds to an occupied table on the same bill', async () => {
    const createdTable = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ capacity: 4, name: 'Corner' });
    expect(createdTable.status).toBe(201);
    const tableId = createdTable.body.data._id;

    const first = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'dine_in',
        tableId,
        items: [{ menuItemId, quantity: 1 }]
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'dine_in',
        tableId,
        items: [{ menuItemId, quantity: 2 }]
      });
    expect(second.status).toBe(200);
    expect(second.body.data._id).toBe(first.body.data._id);
    expect(second.body.data.items).toHaveLength(2);
    expect(second.body.data.items[1].quantity).toBe(2);
    expect(second.body.data.subtotal).toBeGreaterThan(first.body.data.subtotal);

    const occupied = await request(app)
      .get('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '));
    const table = occupied.body.data.find((entry) => entry._id === tableId);
    expect(table.currentStatus).toBe('occupied');
    expect(String(table.activeOrderId)).toBe(first.body.data._id);
  });

  it('lets only hotel admins archive prior-day closed bills and preserves unpaid bills', async () => {
    const tableResponse = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ capacity: 2, name: 'Archive Test' });
    expect(tableResponse.status).toBe(201);
    const tableId = tableResponse.body.data._id;

    const orderResponse = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'dine_in',
        tableId,
        items: [{ menuItemId, quantity: 1 }]
      });
    expect(orderResponse.status).toBe(201);
    const paidOrder = orderResponse.body.data;
    for (const status of ['preparing', 'ready', 'served']) {
      await request(app)
        .patch(`/api/v1/restaurant/orders/${paidOrder._id}/status`)
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send({ status })
        .expect(200);
    }
    await request(app)
      .patch(`/api/v1/restaurant/orders/${paidOrder._id}/settle`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ paymentMethod: 'cash' })
      .expect(200);
    await FoodOrder.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(paidOrder._id) },
      { $set: { createdAt: new Date(Date.now() - 2 * 86400000) } }
    );

    const unpaidTable = await request(app)
      .post('/api/v1/restaurant/tables')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ capacity: 2, name: 'Unpaid Archive Test' });
    const unpaidResponse = await request(app)
      .post('/api/v1/restaurant/orders')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        orderType: 'dine_in',
        tableId: unpaidTable.body.data._id,
        items: [{ menuItemId, quantity: 1 }]
      });
    const unpaidOrder = unpaidResponse.body.data;
    await FoodOrder.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(unpaidOrder._id) },
      { $set: { createdAt: new Date(Date.now() - 2 * 86400000) } }
    );

    const now = new Date();
    const beforeDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    await request(app)
      .post('/api/v1/restaurant/orders/archive-previous-day')
      .set('Authorization', ['Bearer', restaurantToken].join(' '))
      .send({ beforeDate })
      .expect(403);

    const archived = await request(app)
      .post('/api/v1/restaurant/orders/archive-previous-day')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({ beforeDate })
      .expect(200);
    expect(archived.body.data.archivedCount).toBe(1);

    const savedPaidOrder = await FoodOrder.findById(paidOrder._id).lean();
    const savedUnpaidOrder = await FoodOrder.findById(unpaidOrder._id).lean();
    expect(savedPaidOrder.archivedAt).toBeTruthy();
    expect(savedPaidOrder.archivedBy.toString()).toBeTruthy();
    expect(savedUnpaidOrder.archivedAt).toBeNull();
    expect(await AuditLog.findOne({ action: 'ARCHIVE_PREVIOUS_RESTAURANT_BILLS' })).toBeTruthy();

    await request(app)
      .patch(`/api/v1/restaurant/orders/${paidOrder._id}/restore`)
      .set('Authorization', ['Bearer', restaurantToken].join(' '))
      .expect(403);
    await request(app)
      .patch(`/api/v1/restaurant/orders/${paidOrder._id}/restore`)
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    expect((await FoodOrder.findById(paidOrder._id).lean()).archivedAt).toBeNull();
    expect(await AuditLog.findOne({ action: 'RESTORE_ARCHIVED_RESTAURANT_BILL' })).toBeTruthy();
  });

  it('returns today and exactly five separate previous-day billing summaries to hotel admins', async () => {
    const response = await request(app)
      .get('/api/v1/restaurant/billing-history')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const { today, previousDays, todayDate, timeZone } = response.body.data;

    expect(today.date).toBe(todayDate);
    expect(previousDays).toHaveLength(5);
    expect(previousDays.every((day) => day.date < todayDate)).toBe(true);
    expect(new Set(previousDays.map((day) => day.date)).size).toBe(5);
    expect(timeZone).toBeTruthy();
    for (const day of [today, ...previousDays]) {
      expect(day.summary.totalSales).toBeCloseTo(
        day.summary.acSales + day.summary.nonAcSales,
        2
      );
      expect(day.summary.totalSales).toBeCloseTo(
        day.summary.salesBeforeTax + day.summary.taxAmount,
        2
      );
      expect(day.summary).not.toHaveProperty('totalOperationalExpenses');
      expect(day.summary).not.toHaveProperty('netProfit');
      if (day.summary.grossProfitStatus === 'complete' || day.summary.grossProfitStatus === 'partial') {
        expect(day.summary.grossProfit).toBeCloseTo(
          day.summary.paidSales - day.summary.paidFoodCost,
          2
        );
      } else if (day.summary.grossProfitStatus === 'pending') {
        expect(day.summary.grossProfit).toBeNull();
        expect(day.summary.uncostedSalesCount).toBeGreaterThan(0);
      } else {
        expect(day.summary.grossProfit).toBe(0);
        expect(day.summary.paidSales).toBe(0);
      }
      expect(day.bills).toBeInstanceOf(Array);
      expect(day.paymentMethodBreakdown).toBeInstanceOf(Array);
    }

    await request(app)
      .get('/api/v1/restaurant/billing-history?date=2020-01-01')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(400);
    await request(app)
      .get('/api/v1/restaurant/billing-history')
      .set('Authorization', ['Bearer', restaurantToken].join(' '))
      .expect(403);
  });

  it('withholds profit when a completed bill has no recorded food consumption', async () => {
    const orderNumber = `ORD-REPORT-${new mongoose.Types.ObjectId()}`;
    const order = await FoodOrder.create({
      hotelId,
      propertyId,
      orderNumber,
      orderType: 'takeaway',
      diningType: 'non_ac',
      items: [{
        menuItemId,
        name: 'Uncosted report test item',
        quantity: 1,
        unitPrice: 84,
        unitPriceSnapshot: 84,
        diningType: 'non_ac',
        amount: 84
      }],
      subtotal: 84,
      taxAmount: 4.2,
      totalAmount: 88.2,
      status: 'served',
      paymentStatus: 'paid',
      paidAmount: 88.2,
      paidAt: new Date()
    });

    const response = await request(app)
      .get('/api/v1/restaurant/billing-history')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const { today } = response.body.data;

    expect(today.bills.some((bill) => bill._id === String(order._id))).toBe(true);
    expect(today.summary.totalSales).toBeGreaterThanOrEqual(88.2);
    expect(today.summary.taxAmount).toBeGreaterThanOrEqual(4.2);
    expect(today.summary.foodCostStatus).toBe('pending');
    expect(today.summary.uncostedSalesCount).toBeGreaterThan(0);
    expect(today.summary.grossProfit).toBeNull();
    expect(today.summary.grossProfitStatus).toBe('pending');
    expect(today.summary).not.toHaveProperty('netProfit');
    expect(today).not.toHaveProperty('operationalExpenses');
  });

  it('uses recorded recipe stock movements when a sold order has no consumption summary', async () => {
    const beforeResponse = await request(app)
      .get('/api/v1/restaurant/billing-history')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const beforeFoodCost = beforeResponse.body.data.today.summary.totalFoodCost;
    const beforePaidSales = beforeResponse.body.data.today.summary.paidSales;
    const beforePaidFoodCost = beforeResponse.body.data.today.summary.paidFoodCost;
    const beforeGrossProfit = beforeResponse.body.data.today.summary.grossProfit || 0;
    const orderNumber = `ORD-LEGACY-COST-${new mongoose.Types.ObjectId()}`;
    const order = await FoodOrder.create({
      hotelId,
      propertyId,
      orderNumber,
      orderType: 'takeaway',
      diningType: 'non_ac',
      items: [{
        menuItemId: new mongoose.Types.ObjectId(menuItemId),
        name: 'Legacy-cost report test item',
        quantity: 1,
        unitPrice: 20,
        unitPriceSnapshot: 20,
        diningType: 'non_ac',
        amount: 20
      }],
      subtotal: 20,
      taxAmount: 1,
      totalAmount: 21,
      status: 'served',
      paymentStatus: 'paid',
      paidAmount: 21,
      paidAt: new Date()
    });
    await StockMovement.create({
      hotelId,
      propertyId,
      itemId: new mongoose.Types.ObjectId(),
      movementType: 'recipe_consumption',
      transactionDate: new Date(),
      quantity: -2,
      previousStock: 10,
      newStock: 8,
      unitCost: 3.5,
      totalValue: 7,
      orderId: order._id,
      referenceNumber: orderNumber,
      metadata: {
        recipeSources: [{ menuItemId: String(menuItemId) }]
      }
    });

    const response = await request(app)
      .get('/api/v1/restaurant/billing-history')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const { today } = response.body.data;
    expect(today.summary.totalFoodCost - beforeFoodCost).toBeCloseTo(7, 2);
    expect(today.summary.paidSales - beforePaidSales).toBeCloseTo(21, 2);
    expect(today.summary.paidFoodCost - beforePaidFoodCost).toBeCloseTo(7, 2);
    expect(today.summary.grossProfit - beforeGrossProfit).toBeCloseTo(14, 2);
    expect(today.rawMaterialConsumption.some((entry) => entry.reference === orderNumber)).toBe(true);
  });

  it('includes kitchen wastage logs in the restaurant billing report', async () => {
    const wastageReference = `ADJ-REST-WASTE-${new mongoose.Types.ObjectId()}`;
    await StockMovement.create({
      hotelId,
      propertyId,
      itemId: new mongoose.Types.ObjectId(),
      movementType: 'wastage',
      transactionDate: new Date(),
      quantity: -2,
      previousStock: 10,
      newStock: 8,
      unitCost: 4,
      totalValue: 8,
      department: 'Kitchen',
      referenceNumber: wastageReference,
      notes: 'food_wastage: spoiled ingredients'
    });

    const response = await request(app)
      .get('/api/v1/restaurant/billing-history')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const { today } = response.body.data;
    const loggedWastage = today.wastageDetails.find((entry) => entry.reference === wastageReference);

    expect(loggedWastage).toMatchObject({
      department: 'Kitchen',
      totalCost: 8,
      reason: 'food_wastage: spoiled ingredients'
    });
    expect(today.summary.totalWastage).toBeGreaterThanOrEqual(8);
  });

  it('includes restaurant stock-verification consumption in food-cost details', async () => {
    const beforeResponse = await request(app)
      .get('/api/v1/restaurant/billing-history')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const beforeFoodCost = beforeResponse.body.data.today.summary.totalFoodCost;
    const consumptionReference = `VER-UNRECORDED-${new mongoose.Types.ObjectId()}`;
    await StockMovement.create({
      hotelId,
      propertyId,
      itemId: new mongoose.Types.ObjectId(),
      movementType: 'issue',
      transactionDate: new Date(),
      quantity: -2,
      previousStock: 10,
      newStock: 8,
      unitCost: 3,
      totalValue: 6,
      department: 'Kitchen',
      referenceNumber: consumptionReference,
      notes: 'Physical verification consumption. Staff meal preparation.',
      metadata: { source: 'stock_verification_unrecorded_consumption' }
    });

    const response = await request(app)
      .get('/api/v1/restaurant/billing-history')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .expect(200);
    const { today } = response.body.data;
    const consumption = today.rawMaterialConsumption.find((entry) => entry.reference === consumptionReference);

    expect(today.summary.totalFoodCost - beforeFoodCost).toBeCloseTo(6, 2);
    expect(consumption).toMatchObject({
      department: 'Kitchen',
      source: 'stock_verification_unrecorded_consumption',
      totalCost: 6,
      reason: 'Physical verification consumption. Staff meal preparation.'
    });
  });
});
