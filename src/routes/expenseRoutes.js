import { Router } from 'express';
import {
  getExpenses,
  createExpense,
  updateExpense,
  updateExpenseStatus,
  voidExpense,
  uploadExpenseReceiptFile,
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory
} from '../controllers/expenseController.js';
import { authenticate, requireTenant } from '../middlewares/auth.js';
import { uploadExpenseReceipt } from '../middlewares/upload.js';

const router = Router();

router.use(authenticate);
router.use(requireTenant);

router.get('/categories', getExpenseCategories);
router.post('/categories', createExpenseCategory);
router.patch('/categories/:id', updateExpenseCategory);

router.get('/', getExpenses);
router.post('/', createExpense);
router.patch('/:id/status', updateExpenseStatus);
router.patch('/:id/void', voidExpense);
router.delete('/:id', voidExpense);
router.post(
  '/:id/receipt',
  uploadExpenseReceipt.fields([
    { name: 'receipt', maxCount: 1 },
    { name: 'file', maxCount: 1 }
  ]),
  uploadExpenseReceiptFile
);
router.patch('/:id', updateExpense);

export default router;
