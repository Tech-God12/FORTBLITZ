// Extract BANK generators by importing the module with a stubbed window.
global.window = {};
const mod = await import('/home/user/FORTBLITZ/dead-drop/client/js/engine/audio.js');
const { BANK, LOOPING } = mod;
const ids = Object.keys(BANK);
console.log('bank size:', ids.length, 'loops:', LOOPING.size);
let bad = [];
const stats = [];
for (const id of ids) {
  const t0 = Date.now();
  const d = BANK[id]();
  const ms = Date.now() - t0;
  let peak = 0, rms = 0, nan = 0, clip = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (!Number.isFinite(v)) { nan++; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a > 0.999) clip++;
    rms += v * v;
  }
  rms = Math.sqrt(rms / d.length);
  stats.push({ id, dur: (d.length / 48000).toFixed(2), peak: peak.toFixed(3), rms: rms.toFixed(4), nan, clip, ms });
  if (nan > 0) bad.push(`${id}: ${nan} NaN`);
  if (peak < 0.02) bad.push(`${id}: near-silent peak=${peak.toFixed(4)}`);
  if (clip > d.length * 0.02) bad.push(`${id}: ${clip} clipped samples`);
}
const totalMs = stats.reduce((a,b)=>a+b.ms,0);
const totalSec = stats.reduce((a,b)=>a+parseFloat(b.dur),0);
console.log('total synth time:', totalMs+'ms', 'total audio:', totalSec.toFixed(1)+'s');
console.log('slowest:', stats.sort((a,b)=>b.ms-a.ms).slice(0,5).map(s=>`${s.id}=${s.ms}ms`).join(' '));
if (bad.length) { console.log('\nPROBLEMS:'); bad.forEach(b=>console.log(' ', b)); }
else console.log('\nAll sounds OK (audible, no NaN, no excessive clipping)');
