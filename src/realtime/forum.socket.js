import { Server } from 'socket.io';
import { verifyToken } from '../utils/jwt.js';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { setIo } from './io.js';

const ROOM = 'forum';

// userId -> number of active connections (a user may have multiple tabs/devices).
const online = new Map();

const CANNED_REPLIES = [
  'Nice one! I might have a client for that.',
  'Is it still available? Send me the details.',
  'Great deal. Sharing with my network now.',
  'What are the payment terms?',
  'Can you confirm the exact location?',
  'Verified? My clients only want verified listings.',
];

// Socket message shape — carries senderId so each client decides isMe itself.
export function socketMessage(m) {
  return {
    id: m.id,
    sender: m.sender,
    text: m.text,
    avatar: m.avatar,
    senderId: m.userId,
    time: m.createdAt,
    createdAt: m.createdAt,
  };
}

function emitPresence(io) {
  io.to(ROOM).emit('forum:presence', { count: online.size });
}

export function initRealtime(server) {
  const io = new Server(server, {
    cors: {
      origin: env.corsOrigin.includes('*') ? '*' : env.corsOrigin,
      methods: ['GET', 'POST'],
    },
  });
  setIo(io);

  // Authenticate every socket via the same JWT used by the REST API.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = verifyToken(token);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const uid = socket.userId;
    const user = await prisma.user.findUnique({ where: { id: uid } });
    if (!user || user.status === 'disabled') {
      socket.disconnect(true);
      return;
    }

    socket.join(ROOM);
    online.set(uid, (online.get(uid) || 0) + 1);
    emitPresence(io);

    // Send a new forum message → persist + broadcast to everyone live.
    socket.on('forum:send', async (payload, ack) => {
      try {
        const text = (payload?.text || '').toString().trim();
        if (!text) {
          if (typeof ack === 'function') ack({ ok: false });
          return;
        }
        const message = await prisma.forumMessage.create({
          data: { userId: uid, sender: user.name, text: text.slice(0, 2000), avatar: user.avatarUrl },
        });
        io.to(ROOM).emit('forum:message', socketMessage(message));
        if (typeof ack === 'function') ack({ ok: true, id: message.id });

        // Simulated community reply, also broadcast live to all clients.
        setTimeout(async () => {
          try {
            const reply = await prisma.forumMessage.create({
              data: {
                userId: null,
                sender: 'Lagos Homes Realty',
                text: CANNED_REPLIES[Math.floor(Math.random() * CANNED_REPLIES.length)],
                avatar: 'https://api.dicebear.com/7.x/avataaars/png?seed=lagos',
              },
            });
            io.to(ROOM).emit('forum:message', socketMessage(reply));
          } catch (e) {
            console.error('forum reply error:', e.message);
          }
        }, 1800);
      } catch (e) {
        console.error('forum:send error:', e.message);
        if (typeof ack === 'function') ack({ ok: false, error: e.message });
      }
    });

    // Live typing indicator (broadcast to everyone except the sender).
    socket.on('forum:typing', () => {
      socket.to(ROOM).emit('forum:typing', { userId: uid, name: user.name });
    });

    socket.on('disconnect', () => {
      const remaining = (online.get(uid) || 1) - 1;
      if (remaining <= 0) online.delete(uid);
      else online.set(uid, remaining);
      emitPresence(io);
    });
  });

  return io;
}
