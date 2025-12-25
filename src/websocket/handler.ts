import { WebSocket, WebSocketServer } from 'ws';
import path from 'path';
import { processExcelStream } from '../services/processor';

const UPLOAD_DIR = path.join(__dirname, '../../uploads');

export const setupWebSocket = (wss: WebSocketServer) => {
    wss.on('connection', (ws: WebSocket) => {
        console.log('🔌 Client connected');

        ws.on('message', async (message: string) => {
            try {
                const data = JSON.parse(message.toString());

                if (data.type === 'START_PROCESS' && data.fileId) {
                    const filePath = path.join(UPLOAD_DIR, data.fileId);

                    ws.send(JSON.stringify({ type: 'INFO', message: 'Starting processing...' }));

                    await processExcelStream(filePath, (eventData) => {
                        ws.send(JSON.stringify(eventData));
                    });

                    ws.send(JSON.stringify({ type: 'DONE', message: 'All recipes processed.' }));
                }
            } catch (error) {
                console.error('WS Error:', error);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Processing failed.' }));
                }
            }
        });
    });
};
