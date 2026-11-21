'use strict';

const express = require('express');
const router = express.Router();
const ai = require('../services/ai');
const { createLimiter } = require('../services/rateLimit');

// Cap paid AI turns per signed-in user so a single session (or a stuck client
// retry loop) cannot run up the provider bill. Generous by default; set
// AI_RATE_LIMIT_PER_HOUR=0 to disable for a trusted single-user install.
const rawLimit = process.env.AI_RATE_LIMIT_PER_HOUR;
const parsedLimit = rawLimit == null ? 60 : Number(rawLimit);
const AI_LIMIT_PER_HOUR = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? Math.floor(parsedLimit) : 60;
const chatLimiter = createLimiter({ max: AI_LIMIT_PER_HOUR, windowMs: 60 * 60 * 1000 });
function chatGuard(req, res, next) {
  if (AI_LIMIT_PER_HOUR === 0 || chatLimiter.consume(req.user.id)) return next();
  res.setHeader('Retry-After', '3600');
  return res.status(429).json({ error: 'AI request limit reached for this hour. Try again later.' });
}

// Is the assistant configured? The UI reads this to show or hide itself.
router.get('/ai/status', (req, res) => {
  res.json(ai.status());
});

// Live health check: provider reachable, configured models still exist and
// support tool calls, key credit, and free models that could replace a dead
// one. Safe to expose: no key material is returned.
router.get('/ai/diagnose', async (req, res, next) => {
  try { res.json(await ai.diagnose()); } catch (e) { next(e); }
});

// One turn of the conversation. The model may call read tools and draft tools;
// drafts come back as proposals for the human to apply. Nothing is written here.
router.post('/ai/chat', chatGuard, async (req, res, next) => {
  try {
    const messages = (req.body && req.body.messages) || [];
    res.json(await ai.chat({ messages }));
  } catch (e) { next(e); }
});

// The same turn, streamed as Server-Sent Events so the browser can paint the
// answer as it arrives: tool = a tool is running, delta = a text fragment,
// done = the finished reply plus proposals, error = something went wrong.
router.post('/ai/chat/stream', chatGuard, async (req, res) => {
  const messages = (req.body && req.body.messages) || [];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    res.write('event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n');
  };
  let closed = false;
  // res 'close' = the client went away. req 'close' fires when the request
  // body has been read (much earlier), which would swallow every event.
  res.on('close', () => { closed = true; });
  try {
    const out = await ai.chat({
      messages,
      onEvent: (e) => {
        if (e.type === 'delta') send('delta', { text: e.text });
        else if (e.type === 'tool') send('tool', { name: e.name });
      },
    });
    send('done', { reply: out.reply, proposals: out.proposals, model: out.model });
  } catch (e) {
    send('error', { message: e.message, status: e.status || 500, code: e.code || null, failures: e.failures || null });
  }
  if (!res.writableEnded) res.end();
});

module.exports = router;
