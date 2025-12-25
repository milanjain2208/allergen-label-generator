import http from 'http';
import { WebSocketServer } from 'ws';
import app from './app';
import { setupWebSocket } from './websocket/handler';

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

const wss = new WebSocketServer({ server });

setupWebSocket(wss);

server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
});
