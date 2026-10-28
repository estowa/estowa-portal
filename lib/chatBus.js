// WebSocketのハブを、HTTPのルート（添付つき送信など）から使えるようにする置き場
let hub = null;

function setHub(h) {
  hub = h;
}

// ハブがまだない（テストなど）ときは何もしない
function publish(message) {
  if (hub) hub.publish(message);
}

function publishDeleted(roomId, id) {
  if (hub) hub.publishDeleted(roomId, id);
}

function notifyRooms(userIds) {
  if (hub) hub.notifyRooms(userIds);
}

module.exports = { setHub, publish, publishDeleted, notifyRooms };
