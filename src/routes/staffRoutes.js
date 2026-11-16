import { Router } from 'express';
import {
  getStaff,
  getStaffAssignees,
  getStaffById,
  createStaff,
  updateStaff,
  getShifts,
  createShift,
  updateShift,
  getAttendance,
  recordAttendance,
  updateAttendance,
  bulkMarkAttendance,
  getAttendanceSummary,
  getSalaryHistory,
  processSalary,
  checkIn,
  checkOut,
  getMyAttendance,
  getAdvances,
  createAdvance,
  exportSalaryCsv
} from '../controllers/staffController.js';
import { authenticate, requireTenant, authorize, authorizeRoles } from '../middlewares/auth.js';
import { ROLES } from '../config/constants.js';
import { validatePhoneFields } from '../middlewares/phoneValidator.js';
import { getPermissionSettings, updateUserPermissions } from '../controllers/permissionController.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

// ── Staff directory ───────────────────────────────────────────────────────────
router.get('/assignees', getStaffAssignees);
router.get('/permissions', authorizeRoles(ROLES.HOTEL_ADMIN), getPermissionSettings);
router.put('/:id/permissions', authorizeRoles(ROLES.HOTEL_ADMIN), updateUserPermissions);
router.get('/',      getStaff);
router.post('/',     authorizeRoles(ROLES.HOTEL_ADMIN), validatePhoneFields({ path: 'phone' }), createStaff);

// ── Shifts — static sub-routes BEFORE parameterised ones ─────────────────────
router.get('/shifts',       getShifts);
router.post('/shifts',      authorizeRoles(ROLES.HOTEL_ADMIN), createShift);
router.patch('/shifts/:id', authorizeRoles(ROLES.HOTEL_ADMIN), updateShift);

// ── Attendance — static sub-routes FIRST ─────────────────────────────────────
router.get('/attendance/summary', authorizeRoles(ROLES.HOTEL_ADMIN), getAttendanceSummary);
router.post('/attendance/bulk',   authorizeRoles(ROLES.HOTEL_ADMIN), bulkMarkAttendance);
router.post('/attendance/check-in', checkIn);
router.post('/attendance/check-out', checkOut);
router.get('/attendance/me', getMyAttendance);
router.get('/attendance',         getAttendance);
router.post('/attendance',        authorizeRoles(ROLES.HOTEL_ADMIN), recordAttendance);
router.patch('/attendance/:id',   authorizeRoles(ROLES.HOTEL_ADMIN), updateAttendance);

router.get('/advances', authorizeRoles(ROLES.HOTEL_ADMIN), getAdvances);
router.post('/advances', authorizeRoles(ROLES.HOTEL_ADMIN), createAdvance);

// ── Salary ────────────────────────────────────────────────────────────────────
router.get('/salary',          authorizeRoles(ROLES.HOTEL_ADMIN), getSalaryHistory);
router.get('/salary/export',   authorizeRoles(ROLES.HOTEL_ADMIN), exportSalaryCsv);
router.post('/salary/process', authorizeRoles(ROLES.HOTEL_ADMIN), processSalary);

// ── Staff by ID — parameterised routes LAST ───────────────────────────────────
router.get('/:id',   getStaffById);
router.patch('/:id', authorizeRoles(ROLES.HOTEL_ADMIN), validatePhoneFields({ path: 'phone' }), updateStaff);

export default router;
