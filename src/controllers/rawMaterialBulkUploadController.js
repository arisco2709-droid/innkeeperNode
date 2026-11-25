import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { InventoryItem, RawMaterialBulkUploadLog, RawMaterialCategory, RawMaterialSubcategory, StorageLocation, Unit, Vendor } from '../models/index.js';
import { logAudit } from '../services/auditService.js';
import { evaluateAutomaticReorder, runInventoryTransaction } from '../services/inventoryService.js';
import { logger } from '../config/logger.js';
import { saveRawMaterial } from './rawMaterialController.js';
import {
  MAX_BULK_ROWS,
  TEMPLATE_COLUMNS,
  buildFailedWorkbookBuffer,
  buildTemplateCsv,
  buildTemplateWorkbook,
  isRowEmpty,
  isSampleRow,
  isValidRawMaterialTemplate,
  normalizeMaterialName,
  parseUploadBuffer,
  prepareRawMaterialRow,
  uploadStatusFor
} from '../services/rawMaterialBulkUploadService.js';

const sendError = (res, status, message) => res.status(status).json({ success: false, message });

const uploadRoot = () => path.resolve(process.cwd(), 'uploads', 'raw-material-bulk');

const isInsideUploadRoot = (filePath) => {
  if (!filePath) return false;
  const root = uploadRoot();
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const writeUploadFile = (hotelId, filename, contents) => {
  const directory = path.join(uploadRoot(), String(hotelId));
  fs.mkdirSync(directory, { recursive: true });
  const absolute = path.join(directory, filename);
  fs.writeFileSync(absolute, contents);
  return absolute;
};

const uploadedByName = (user) => String(user?.name || user?.email || 'Unknown user').trim() || 'Unknown user';

const summaryMessage = ({ totalRecords, successCount, failedCount, duplicateCount }) => {
  if (totalRecords > 0 && successCount === totalRecords) {
    return `All ${totalRecords} raw materials were imported.`;
  }
  if (successCount === 0) {
    return `No raw materials were imported. ${failedCount} failed and ${duplicateCount} duplicates were skipped.`;
  }
  return `Imported ${successCount} of ${totalRecords}. ${failedCount} failed and ${duplicateCount} duplicates were skipped.`;
};

const loadReferenceData = async (hotelId, propertyId) => {
  const [categories, subcategories, units, locations, vendors, materials] = await Promise.all([
    RawMaterialCategory.find({ hotelId }).select('name isActive').lean(),
    RawMaterialSubcategory.find({ hotelId }).select('name categoryId isActive').lean(),
    Unit.find({ hotelId }).lean(),
    StorageLocation.find({ hotelId }).select('locationName isActive').lean(),
    Vendor.find({ hotelId }).select('name status').lean(),
    InventoryItem.find({ hotelId, propertyId, inventoryType: 'raw_material' }).select('name').lean()
  ]);
  return {
    hotelId,
    categories,
    subcategories,
    units,
    locations,
    vendors,
    existingNames: new Set(materials.map((item) => normalizeMaterialName(item.name)))
  };
};

const publicLog = (log) => ({
  _id: log._id,
  fileName: log.fileName,
  totalRows: log.totalRows,
  successCount: log.successCount,
  failedCount: log.failedCount,
  duplicateCount: log.duplicateCount,
  uploadStatus: log.uploadStatus,
  uploadedByName: log.uploadedByName || log.uploadedBy?.name || 'Unknown user',
  remarks: log.remarks,
  createdAt: log.createdAt,
  hasFailedFile: Boolean(log.failedFilePath),
  rowResults: log.rowResults || []
});

export const downloadRawMaterialBulkTemplate = async (req, res, next) => {
  try {
    if (!req.hotelId) return sendError(res, 400, 'A hotel context is required to download the template.');
    const context = await loadReferenceData(req.hotelId, req.propertyId);
    const fileBase = 'Raw_Material_Bulk_Upload_Template';
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
      return res.send(buildTemplateCsv());
    }
    const workbook = await buildTemplateWorkbook(context);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    return next(error);
  }
};

export const uploadRawMaterialsBulk = async (req, res, next) => {
  let uploadLog = null;
  try {
    if (!req.hotelId || !req.propertyId) {
      return sendError(res, 400, 'A hotel and property context are required to import raw materials.');
    }
    if (!req.file?.buffer) return sendError(res, 400, 'An Excel or CSV file is required.');

    const originalName = req.file.originalname || 'raw-material-bulk-upload.xlsx';
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    let originalFilePath = '';
    try {
      originalFilePath = writeUploadFile(req.hotelId, `original_${Date.now()}_${safeName}`, req.file.buffer);
    } catch (error) {
      logger.error(`Could not store raw material bulk file: ${error.message}`);
    }

    uploadLog = await RawMaterialBulkUploadLog.create({
      hotelId: req.hotelId,
      propertyId: req.propertyId,
      fileName: originalName,
      originalFilePath,
      uploadStatus: 'Processing',
      uploadedBy: req.user?._id || null,
      uploadedByName: uploadedByName(req.user)
    });

    const { headers, rows } = await parseUploadBuffer(req.file.buffer, originalName);
    if (!isValidRawMaterialTemplate(headers)) {
      uploadLog.uploadStatus = 'Failed';
      uploadLog.remarks = 'Invalid raw material bulk upload template.';
      await uploadLog.save();
      return sendError(res, 400, 'Invalid template. Download the latest raw material bulk upload template and use those column headings.');
    }

    const dataRows = rows.filter((row) => !isSampleRow(row) && !isRowEmpty(row));
    if (!dataRows.length) {
      uploadLog.uploadStatus = 'Failed';
      uploadLog.remarks = 'No data rows found.';
      await uploadLog.save();
      return sendError(res, 400, 'No raw material rows were found. Example rows that start with "ex:" are ignored.');
    }
    if (dataRows.length > MAX_BULK_ROWS) {
      uploadLog.uploadStatus = 'Failed';
      uploadLog.totalRows = dataRows.length;
      uploadLog.remarks = `The file has ${dataRows.length} rows. The limit is ${MAX_BULK_ROWS}.`;
      await uploadLog.save();
      return sendError(res, 400, `A bulk upload can contain at most ${MAX_BULK_ROWS} raw materials. Split the file and try again.`);
    }

    const context = await loadReferenceData(req.hotelId, req.propertyId);
    let successCount = 0;
    let failedCount = 0;
    let duplicateCount = 0;
    const rowResults = [];

    for (const row of dataRows) {
      const values = Object.fromEntries(TEMPLATE_COLUMNS.map((column) => [column.field, row[column.field] ?? '']));
      const result = await prepareRawMaterialRow(row, context);
      const messages = result.errors?.length ? result.errors : [];
      if (result.isDuplicate) {
        duplicateCount += 1;
        rowResults.push({
          rowNumber: row.__excelRow,
          materialName: result.data?.name || '',
          status: 'Duplicate',
          messages,
          values
        });
        continue;
      }
      if (!result.ok) {
        failedCount += 1;
        rowResults.push({
          rowNumber: row.__excelRow,
          materialName: result.data?.name || '',
          status: 'Failed',
          messages: messages.length ? messages : ['This row could not be imported.'],
          values
        });
        continue;
      }

      try {
        const saved = await saveRawMaterial({
          req: {
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            user: req.user,
            headers: req.headers || {},
            socket: req.socket || {},
            get: typeof req.get === 'function' ? req.get.bind(req) : () => undefined,
            body: result.payload
          }
        });
        if (saved.error || saved.conflict) {
          failedCount += 1;
          rowResults.push({
            rowNumber: row.__excelRow,
            materialName: result.payload.name,
            status: 'Failed',
            messages: [saved.error || saved.conflict],
            values
          });
          continue;
        }
        const item = await InventoryItem.create({
          ...saved.itemFields,
          hotelId: req.hotelId,
          propertyId: req.propertyId
        });
        try {
          await runInventoryTransaction((session) => evaluateAutomaticReorder({
            hotelId: req.hotelId,
            propertyId: req.propertyId,
            itemId: item._id,
            recordedBy: req.user._id,
            session
          }));
        } catch (reorderError) {
          logger.error(`Automatic reorder failed for imported raw material ${item._id}: ${reorderError.message}`);
        }
        await logAudit({
          hotelId: req.hotelId,
          action: 'CREATE_RAW_MATERIAL',
          entity: 'InventoryItem',
          entityId: item._id,
          details: { name: item.name, code: item.code, source: 'bulk_upload' },
          req
        });
        context.existingNames.add(normalizeMaterialName(item.name));
        successCount += 1;
        rowResults.push({
          rowNumber: row.__excelRow,
          materialName: item.name,
          status: 'Success',
          messages: ['Raw material imported.'],
          values
        });
      } catch (error) {
        failedCount += 1;
        rowResults.push({
          rowNumber: row.__excelRow,
          materialName: result.payload?.name || '',
          status: 'Failed',
          messages: [error.code === 11000
            ? 'A raw material with this code or name already exists.'
            : (error.message || 'This row could not be imported.')],
          values
        });
      }
    }

    const rejected = rowResults.filter((result) => result.status !== 'Success');
    let failedFilePath = '';
    if (rejected.length) {
      const buffer = await buildFailedWorkbookBuffer(rejected);
      failedFilePath = writeUploadFile(
        req.hotelId,
        `failed_${uploadLog._id}_${Date.now()}.xlsx`,
        Buffer.from(buffer)
      );
    }

    const uploadStatus = uploadStatusFor({ successCount, failedCount, duplicateCount });
    uploadLog.totalRows = dataRows.length;
    uploadLog.successCount = successCount;
    uploadLog.failedCount = failedCount;
    uploadLog.duplicateCount = duplicateCount;
    uploadLog.uploadStatus = uploadStatus;
    uploadLog.failedFilePath = failedFilePath;
    uploadLog.remarks = summaryMessage({
      totalRecords: dataRows.length,
      successCount,
      failedCount,
      duplicateCount
    });
    uploadLog.rowResults = rowResults.map(({ values, ...result }) => result);
    await uploadLog.save();

    if (successCount > 0) {
      await logAudit({
        hotelId: req.hotelId,
        action: 'BULK_UPLOAD_RAW_MATERIALS',
        entity: 'RawMaterialBulkUploadLog',
        entityId: uploadLog._id,
        details: {
          fileName: originalName,
          totalRecords: dataRows.length,
          successCount,
          failedCount,
          duplicateCount
        },
        req
      });
    }

    return res.json({
      success: true,
      message: uploadLog.remarks,
      totalRecords: dataRows.length,
      successCount,
      failedCount,
      duplicateCount,
      uploadStatus,
      logId: uploadLog._id,
      rowErrors: rejected.slice(0, 200).map(({ values, ...result }) => result)
    });
  } catch (error) {
    if (uploadLog) {
      uploadLog.uploadStatus = 'Failed';
      uploadLog.remarks = error.message || 'Upload failed.';
      await uploadLog.save().catch(() => {});
    }
    return next(error);
  }
};

export const getRawMaterialBulkUploadLogs = async (req, res, next) => {
  try {
    if (!req.hotelId || !req.propertyId) {
      return sendError(res, 400, 'A hotel and property context are required to load upload logs.');
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const filter = { hotelId: req.hotelId, propertyId: req.propertyId };
    if (req.query.status && req.query.status !== 'ALL') filter.uploadStatus = req.query.status;
    if (req.query.fromDate || req.query.toDate) {
      filter.createdAt = {};
      if (req.query.fromDate) {
        const from = new Date(`${req.query.fromDate}T00:00:00.000`);
        if (Number.isNaN(from.getTime())) return sendError(res, 400, 'Choose a valid start date.');
        filter.createdAt.$gte = from;
      }
      if (req.query.toDate) {
        const to = new Date(`${req.query.toDate}T23:59:59.999`);
        if (Number.isNaN(to.getTime())) return sendError(res, 400, 'Choose a valid end date.');
        filter.createdAt.$lte = to;
      }
    }
    const [logs, total] = await Promise.all([
      RawMaterialBulkUploadLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-rowResults -originalFilePath')
        .populate('uploadedBy', 'name email')
        .lean(),
      RawMaterialBulkUploadLog.countDocuments(filter)
    ]);
    return res.json({
      success: true,
      data: logs.map((log) => ({ ...publicLog(log), rowResults: undefined })),
      pagination: {
        totalRecords: total,
        currentPage: page,
        totalPages: Math.ceil(total / limit) || 1,
        limit
      }
    });
  } catch (error) {
    return next(error);
  }
};

export const getRawMaterialBulkUploadLog = async (req, res, next) => {
  try {
    if (!req.hotelId || !req.propertyId) {
      return sendError(res, 400, 'A hotel and property context are required to load this upload.');
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return sendError(res, 404, 'Bulk upload log not found.');
    const log = await RawMaterialBulkUploadLog.findOne({
      _id: req.params.id,
      hotelId: req.hotelId,
      propertyId: req.propertyId
    }).populate('uploadedBy', 'name email').lean();
    if (!log) return sendError(res, 404, 'Bulk upload log not found.');
    return res.json({ success: true, data: publicLog(log) });
  } catch (error) {
    return next(error);
  }
};

export const downloadRawMaterialBulkFailedFile = async (req, res, next) => {
  try {
    if (!req.hotelId || !req.propertyId) {
      return sendError(res, 400, 'A hotel and property context are required to download failed records.');
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return sendError(res, 404, 'Bulk upload log not found.');
    const log = await RawMaterialBulkUploadLog.findOne({
      _id: req.params.id,
      hotelId: req.hotelId,
      propertyId: req.propertyId
    }).select('failedFilePath fileName').lean();
    if (!log) return sendError(res, 404, 'Bulk upload log not found.');
    if (!log.failedFilePath || !isInsideUploadRoot(log.failedFilePath) || !fs.existsSync(log.failedFilePath)) {
      return sendError(res, 404, 'No failed records are available for this upload.');
    }
    const downloadName = `Failed_${String(log.fileName || 'raw-materials').replace(/\.(csv|xlsx|xls)$/i, '')}.xlsx`;
    return res.download(path.resolve(log.failedFilePath), downloadName);
  } catch (error) {
    return next(error);
  }
};
