import fs from 'fs';
import path from 'path';
import multer from 'multer';

const storage = multer.memoryStorage();

export const uploadExcel = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype?.includes('sheet') ||
      file.mimetype === 'application/vnd.ms-excel' ||
      /\.xlsx?$/i.test(file.originalname || '');
    if (!ok) return cb(new Error('Only Excel files (.xlsx/.xls) are allowed.'));
    cb(null, true);
  }
});

export const uploadRawMaterialBulk = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const ok = ['.xlsx', '.xls', '.csv'].includes(extension);
    if (!ok) return cb(new Error('Unsupported file format. Please upload .xlsx, .xls, or .csv.'));
    cb(null, true);
  }
});

const receiptUploadDir = path.join(process.cwd(), 'uploads', 'expenses');
fs.mkdirSync(receiptUploadDir, { recursive: true });

const receiptDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(receiptUploadDir, { recursive: true });
    cb(null, receiptUploadDir);
  },
  filename: (_req, file, cb) => {
    const safeName = String(file.originalname || 'receipt')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 120);
    cb(null, `${Date.now()}_${safeName}`);
  }
});

export const uploadExpenseReceipt = multer({
  storage: receiptDiskStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype?.startsWith('image/') ||
      file.mimetype === 'application/pdf' ||
      /\.(jpe?g|png|gif|webp|pdf)$/i.test(file.originalname || '');
    if (!ok) return cb(new Error('Only image or PDF receipts are allowed.'));
    cb(null, true);
  }
});
