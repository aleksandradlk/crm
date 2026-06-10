const db = require('../db');

async function log(userId, action, targetType, targetId, detail, ip) {
  try {
    await db.query(
      'INSERT INTO activity_log (user_id, action, target_type, target_id, detail, ip) VALUES (?,?,?,?,?,?)',
      [userId, action, targetType || null, targetId || null,
       detail ? JSON.stringify(detail) : null, ip || null]
    );
  } catch (e) {
    console.error('Activity log error:', e.message);
  }
}

module.exports = { log };
