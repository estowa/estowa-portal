const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { getRemoteUser, canPair, peersOf } = require('../lib/chatRules');
const { listMessages, unreadCounts } = require('../lib/chatStore');

const router = express.Router();

function buildIceServers(env) {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (env.TURN_URL) {
    servers.push({ urls: env.TURN_URL, username: env.TURN_USER || '', credential: env.TURN_PASS || '' });
  }
  return servers;
}

function buildChatState(database, userId, env) {
  const remote = getRemoteUser(database);
  const me = database.prepare('SELECT user_id, display_name FROM users WHERE user_id = ?').get(userId);
  const unread = unreadCounts(database, userId);
  return {
    me: { user_id: me.user_id, display_name: me.display_name, isRemote: !!remote && remote.user_id === userId },
    remoteConfigured: !!remote,
    peers: peersOf(database, userId).map((p) => ({
      user_id: p.user_id,
      display_name: p.display_name,
      unread: unread[p.user_id] || 0,
    })),
    iceServers: buildIceServers(env),
  };
}

router.get('/chat/state', requireLogin, (req, res) => {
  res.json(buildChatState(db, req.session.user.user_id, process.env));
});

router.get('/chat/messages/:peerUserId', requireLogin, (req, res) => {
  const me = req.session.user.user_id;
  if (!canPair(db, me, req.params.peerUserId)) return res.status(403).json({ error: 'forbidden' });
  res.json({ messages: listMessages(db, me, req.params.peerUserId) });
});

module.exports = router;
module.exports.buildChatState = buildChatState;
