global.window = {};
import fs from 'fs';
const { BANK } = await import('/home/user/FORTBLITZ/dead-drop/client/js/engine/audio.js');
const SR=48000;
function wav(data){
  const n=data.length, b=Buffer.alloc(44+n*2);
  b.write('RIFF',0);b.writeUInt32LE(36+n*2,4);b.write('WAVE',8);b.write('fmt ',12);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(SR,24);
  b.writeUInt32LE(SR*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++)b.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(data[i]*32767))),44+i*2);
  return b;
}
fs.mkdirSync('/tmp/aud',{recursive:true});
for(const id of ['weapon.scar','weapon.pump','weapon.bolt_sniper','chest.hum','build.wood','build.metal','ui.victory','explosion.rocket','storm.wall','bus.horn']){
  fs.writeFileSync(`/tmp/aud/${id.replace('.','_')}.wav`, wav(BANK[id]()));
}
console.log('exported');
