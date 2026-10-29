// セッションに入っているログイン情報を、DBの現在の内容に合わせる。
// 権限を下げたり、ユーザーを削除したりしたとき、残っているセッション(最長7日)がそのまま効き続けないようにする。
// fresh は DB の users の行（なければ null）。ログインが有効なら true

function applyFreshUser(session, fresh) {
  if (!session || !session.user) return false;
  if (!fresh) {
    delete session.user;
    return false;
  }
  const u = session.user;
  if (u.id !== fresh.id || u.role !== fresh.role || u.display_name !== fresh.display_name) {
    session.user = { id: fresh.id, user_id: fresh.user_id, display_name: fresh.display_name, role: fresh.role };
  }
  return true;
}

module.exports = { applyFreshUser };
