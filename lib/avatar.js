// ユーザーアイコン(アバター)まわりの共通処理
// 各ユーザーは絵文字+背景色を自分で設定できる。未設定の場合は
// ユーザーIDから決定的に色を割り当て、表示名の頭文字を表示する。

const COLOR_OPTIONS = [
  '#5b6ee1', '#e15b8f', '#2bb3a3', '#e1a75b', '#7bbf6a',
  '#a15be1', '#e1625b', '#4aa8d8', '#c9a227', '#6a7bbf',
];

// タスクの添付/コメントで使えるアイコン候補(絵文字)
const EMOJI_OPTIONS = [
  '😀', '😎', '🙂', '🤓', '🥳', '🐱', '🐶', '🦊', '🐻', '🐼',
  '🐨', '🦁', '🐯', '🐸', '🐵', '🦄', '🐙', '🦉', '🐝', '🐧',
  '🌸', '🌟', '🔥', '⚡', '🍀', '🎨', '🎯', '🚀', '⚓', '🏆',
  '💡', '🎵', '☕', '🍩', '🍎',
];

function colorForUser(userId) {
  const id = userId || '';
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return COLOR_OPTIONS[hash % COLOR_OPTIONS.length];
}

// user: { user_id, display_name, avatar_emoji, avatar_color, avatar_image } を受け取り
// 表示に必要な { emoji, color, initial, image } を返す
// image(アップロード画像)が設定されていれば絵文字より優先して表示する
function avatarFor(user) {
  if (!user) return { emoji: null, color: '#b0b3c0', initial: '?', image: null };
  return {
    emoji: user.avatar_emoji || null,
    color: user.avatar_color || colorForUser(user.user_id),
    initial: (user.display_name || user.user_id || '?').slice(0, 1),
    image: user.avatar_image || null,
  };
}

module.exports = { avatarFor, colorForUser, COLOR_OPTIONS, EMOJI_OPTIONS };
