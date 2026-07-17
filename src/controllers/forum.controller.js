import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicForumMessage } from '../utils/serialize.js';
import { ok, created } from '../utils/respond.js';
import { getIo } from '../realtime/io.js';
import { socketMessage } from '../realtime/forum.socket.js';

// Broadcast a message to all connected forum clients (if realtime is up).
const broadcast = (m) => getIo()?.to('forum').emit('forum:message', socketMessage(m));

export const postMessageSchema = z.object({
  text: z.string().trim().min(1, 'Message cannot be empty.').max(2000),
});

// Canned replies for the simulated forum bot.
const CANNED_REPLIES = [
  'Nice one! I might have a client for that.',
  'Is it still available? Send me the details.',
  'Great deal. Sharing with my network now.',
  'What are the payment terms?',
  'Can you confirm the exact location?',
  'Verified? My clients only want verified listings.',
];

// GET /api/forum/messages — chat history (oldest first).
export const listMessages = asyncHandler(async (req, res) => {
  const rows = await prisma.forumMessage.findMany({
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  const online = 5;
  return ok(res, rows.map((m) => publicForumMessage(m, req.user?.id)), {
    meta: { count: rows.length, membersOnline: online },
  });
});

// POST /api/forum/messages — send a message; returns the message + a simulated reply.
export const postMessage = asyncHandler(async (req, res) => {
  const message = await prisma.forumMessage.create({
    data: {
      userId: req.user.id,
      sender: req.user.name,
      text: req.body.text,
      avatar: req.user.avatarUrl,
    },
  });

  broadcast(message);

  // Simulated reply from "Lagos Homes Realty" (matches frontend behaviour).
  const reply = await prisma.forumMessage.create({
    data: {
      userId: null,
      sender: 'Lagos Homes Realty',
      text: CANNED_REPLIES[Math.floor(Math.random() * CANNED_REPLIES.length)],
      avatar: 'https://api.dicebear.com/7.x/avataaars/png?seed=lagos',
      createdAt: new Date(Date.now() + 1000),
    },
  });
  broadcast(reply);

  return created(res, {
    message: publicForumMessage(message, req.user.id),
    reply: publicForumMessage(reply, req.user.id),
  });
});
