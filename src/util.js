function isUrl(s) {
  try { new URL(s); return true; } catch { return false; }
}

function pickIdentifier(query) {
  // لو رابط: نرسله مباشرة لـ Lavalink
  if (isUrl(query)) return query;

  // افتراضياً نبحث يوتيوب (يتطلب مصدر/بلجن مناسب في Lavalink)
  // تقدر تغيّرها إلى scsearch: لو تبغى SoundCloud افتراضياً
  return `ytsearch:${query}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

module.exports = { isUrl, pickIdentifier, clamp };
