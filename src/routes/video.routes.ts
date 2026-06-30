import { Router } from 'express';
import { uploadMiddleware } from '../middlewares/upload.middleware';
import { uploadVideo, processRemoteVideo, getJobStatus } from '../controllers/video.controller';
import { requireApiKey } from '../middlewares/auth.middleware';

const router = Router();

// Apply API Key Authentication to all video routes
router.use(requireApiKey);

// Routes
router.post('/upload', uploadMiddleware.single('video'), uploadVideo);
router.post('/process-remote', processRemoteVideo);
router.get('/status/:jobId', getJobStatus);

export default router;