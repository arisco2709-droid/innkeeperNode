import { Router } from 'express';
import {
  getMenu,
  createCategory,
  updateCategory,
  createMenuItem,
  updateMenuItem,
  getOrders,
  getTables,
  createTable,
  updateTable,
  createOrder,
  updateOrderStatus,
  updateBillAmounts,
  settleOrder,
  archivePreviousDayBills,
  restoreArchivedBill,
  transferToRoomFolio
} from '../controllers/restaurantController.js';
import {
  getRestaurantBillingHistory,
  hideRestaurantBillingReport,
  requestRestaurantBillingReportRestore,
  reviewRestaurantBillingReportRestore
} from '../controllers/restaurantBillingController.js';
import { authenticate, requireTenant, authorize, authorizeRoles } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/menu', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), getMenu);
router.post('/categories', authorize(), createCategory);
router.patch('/categories/:id', authorize(), updateCategory);
router.post('/items', authorize(), createMenuItem);
router.patch('/items/:id', authorize(), updateMenuItem);

router.get('/orders', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), getOrders);
router.get('/billing-history', authorize(ROLES.HOTEL_ADMIN, ROLES.SUPER_ADMIN), getRestaurantBillingHistory);
router.post('/billing-history/:date/hide', authorizeRoles(ROLES.HOTEL_ADMIN), hideRestaurantBillingReport);
router.post('/billing-history/:date/restore-requests', authorizeRoles(ROLES.HOTEL_ADMIN), requestRestaurantBillingReportRestore);
router.patch('/billing-history/restore-requests/:requestId', authorizeRoles(ROLES.SUPER_ADMIN), reviewRestaurantBillingReportRestore);
router.post('/orders', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), createOrder);
router.patch('/orders/:id/status', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), updateOrderStatus);
router.patch('/orders/:id/bill-amounts', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), updateBillAmounts);
router.patch('/orders/:id/settle', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), settleOrder);
router.post('/orders/archive-previous-day', authorizeRoles(ROLES.HOTEL_ADMIN), archivePreviousDayBills);
router.patch('/orders/:id/restore', authorizeRoles(ROLES.HOTEL_ADMIN), restoreArchivedBill);
router.post('/orders/transfer-to-folio', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), transferToRoomFolio);
router.get('/tables', authorize(ROLES.HOTEL_ADMIN, ROLES.RESTAURANT_STAFF), getTables);
router.post('/tables', authorizeRoles(ROLES.HOTEL_ADMIN), createTable);
router.patch('/tables/:id', authorizeRoles(ROLES.HOTEL_ADMIN), updateTable);

export default router;
