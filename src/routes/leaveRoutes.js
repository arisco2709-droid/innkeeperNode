import { Router } from 'express';
import {
  cancelLeaveRequest,
  createLeaveRequest,
  getLeaveRequests,
  getLeaveTypes,
  reviewLeaveRequest,
  updateLeaveTypes
} from '../controllers/leaveController.js';
import { authenticate, authorize, authorizeRoles, requireTenant } from '../middlewares/auth.js';
import { HOTEL_STAFF_ROLES, ROLES } from '../config/constants.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/types', getLeaveTypes);
router.put('/types', authorizeRoles(ROLES.HOTEL_ADMIN), updateLeaveTypes);
router.get('/requests', getLeaveRequests);
router.post('/requests', authorize(ROLES.HOTEL_ADMIN, ...HOTEL_STAFF_ROLES), createLeaveRequest);
router.patch('/requests/:id/review', authorizeRoles(ROLES.HOTEL_ADMIN), reviewLeaveRequest);
router.post('/requests/:id/cancel', cancelLeaveRequest);

export default router;
