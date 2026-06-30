import multer from 'multer';
import path from 'path';
import { Request } from 'express';
import { config } from '../config/env';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const allowedMimeTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
const allowedExtensions = ['.mp4', '.webm', '.mov', '.mkv'];

const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const fileExt = path.extname(file.originalname).toLowerCase();
  const fileMime = file.mimetype.toLowerCase();

  const isAllowedMime = allowedMimeTypes.includes(fileMime);
  const isAllowedExt = allowedExtensions.includes(fileExt);

  // Allow if explicitly categorized as a valid video mimetype OR
  // if the client sent a generic/unknown stream mimetype but the file extension is valid
  if (isAllowedMime || (fileMime === 'application/octet-stream' && isAllowedExt)) {
    cb(null, true);
  } else {
    logger.warn(`Unsupported file format: ${file.mimetype} from ${req.ip}`, {
      method: req.method,
      url: req.originalUrl,
      mimetype: file.mimetype,
      originalname: file.originalname,
      ip: req.ip,
    });
    cb(new AppError(`Unsupported file format: ${file.mimetype}. Only MP4, WebM, and MOV are allowed.`, 400));
  }
};

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: config.MAX_FILE_SIZE },
  fileFilter,
});
