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

const upload = multer({
    dest: uploadDir,
    fileFilter: (req, file, cb) => {
        // Check for excel mimetype or extension
        const allowedMimeTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel'
        ];
        // Some browsers/OS might not send correct MIME type, so check extension too
        const isXlsx = file.originalname.toLowerCase().endsWith('.xlsx');

        if (allowedMimeTypes.includes(file.mimetype) || isXlsx) {
            cb(null, true);
        } else {
            cb(new Error('Only .xlsx files are allowed!'));
        }
    }
});

// Middleware wrapper to handle multer errors
const uploadMiddleware = (req: Request, res: Response, next: any) => {
    const uploadSingle = upload.single('file');

    uploadSingle(req, res, (err: any) => {
        if (err) {
            return res.status(400).json({ error: err?.message });
        }
        next();
    });
};

router.post('/upload', uploadMiddleware, (req: Request, res: Response): void => {
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
