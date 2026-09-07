import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/epat/.eteams/db/eteams.db', { readOnly: true });
const q = (sql) => {
  try {
    return db.prepare(sql).all();
  } catch (e) {
    return [{ ERROR: String(e) }];
  }
};
const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
console.log(
  'task_members 领队主持行:',
  JSON.stringify(
    q('SELECT task_member_id, main_task_id, name, session_id, model, provider, reasoning_effort, is_leader, status, update_time FROM task_members WHERE main_task_id IS NULL').map((r) => ({
      ...r,
      updated: iso(r.update_time),
    })),
  ),
);
console.log(
  'team_members 领队班底行:',
  JSON.stringify(
    q('SELECT team_member_id, role_name, model, provider, is_leader, update_time FROM team_members WHERE is_leader = 1').map((r) => ({
      ...r,
      updated: iso(r.update_time),
    })),
  ),
);
console.log(
  'team_members 成员行(前4):',
  JSON.stringify(
    q('SELECT team_member_id, role_name, model, provider FROM team_members WHERE is_leader = 0 LIMIT 4'),
  ),
);
console.log(
  '最近 member.updated:',
  JSON.stringify(
    q("SELECT event_id, event_time, payload FROM events WHERE type='member.updated' ORDER BY event_id DESC LIMIT 4").map((r) => ({
      ...r,
      at: iso(r.event_time),
      payload: r.payload == null ? null : String(r.payload).slice(0, 200),
    })),
  ),
);
db.close();
