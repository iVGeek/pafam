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

module.exports = router;
