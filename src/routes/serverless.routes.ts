import { Router } from 'express';
import { benchmarkServerlessWorker, processServerlessVideo } from '../controllers/serverless.controller';

const router = Router();

router.post('/benchmark', benchmarkServerlessWorker);
router.post('/transcode', processServerlessVideo);

export default router;
