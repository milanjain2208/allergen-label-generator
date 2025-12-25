import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

// Ensuring uploads directory exists
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const upload = multer({ dest: uploadDir });

router.post('/upload', upload.single('file'), (req: Request, res: Response): void => {
    if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
    }

    // Returning the filename so the frontend can reference it via WebSocket
    res.json({
        message: 'File uploaded successfully',
        fileId: req.file.filename
    });
});

export default router;
