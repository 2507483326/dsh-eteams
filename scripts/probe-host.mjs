// 探测运行中的 DSH 宿主：eteams web 面是否绑定、roster 是否可读。
const base = 'http://127.0.0.1:43120';
const paths = ['/eteams-api/roster', '/plugins/dsh-eteams/eteams-api/roster', '/'];
for (const p of paths) {
  try {
    const res = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    console.log(p, '->', res.status, body.slice(0, 200).replace(/\n/g, ' '));
  } catch (e) {
    console.log(p, '-> ERR', String(e).slice(0, 120));
  }
}
