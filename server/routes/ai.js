'use strict';

const express = require('express');
const router = express.Router();
const ai = require('../services/ai');

// Is the assistant configured? The UI reads this to show or hide itself.
router.get('/ai/status', (req, res) => {
  res.json(ai.status());
});

// One turn of the conversation. The model may call read tools and draft tools;
// drafts come back as proposals for the human to apply. Nothing is written here.
router.post('/ai/chat', async (req, res, next) => {
  try {
    const messages = (req.body && req.body.messages) || [];
    res.json(await ai.chat({ messages }));
  } catch (e) { next(e); }
});

// The same turn, streamed as Server-Sent Events so the browser can paint the
// answer as it arrives: tool = a tool is running, delta = a text fragment,
// done = the finished reply plus proposals, error = something went wrong.
router.post('/ai/chat/stream', async (req, res) => {
  const messages = (req.body && req.body.messages) || [];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => { res.write('event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n'); };
  let closed = false;
  req.on('close', () => { closed = true; });
  try {
    const out = await ai.chat({
      messages,
      onEvent: (e) => {
        if (closed) return;
        if (e.type === 'delta') send('delta', { text: e.text });
        else if (e.type === 'tool') send('tool', { name: e.name });
      },
    });
    if (!closed) send('done', { reply: out.reply, proposals: out.proposals, model: out.model });
  } catch (e) {
    if (!closed) send('error', { message: e.message, status: e.status || 500 });
  }
  res.end();
});

module.exports = router;
