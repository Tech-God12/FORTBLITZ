import fs from 'fs';
import hf from '/home/user/FORTBLITZ/dead-drop/client/js/world/heightfield.js';
import map from '/home/user/FORTBLITZ/dead-drop/client/js/config/map.json' with {type:'json'};
const S=700, W=4000, half=2000;
const px=Buffer.alloc(S*S*3);
const cols=map.terrainLayers.map(l=>l.color).map(c=>[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)]);
for(let j=0;j<S;j++){for(let i=0;i<S;i++){
  const x=-half+ (i/S)*W, z=-half+(j/S)*W;
  const h=hf.getHeight(x,z); const wl=hf.getWaterLevel(x,z);
  let c;
  if(h<wl-0.2){ const d=Math.min(1,(wl-h)/25); c=[Math.round(40-20*d),Math.round(110-50*d),Math.round(180-40*d)];}
  else { c=cols[hf.getLayerIndex(x,z)].slice();
    // hillshade
    const n=hf.getNormal(x,z,4); const l=Math.max(0.25,n.x*-0.5+n.y*0.75+n.z*-0.4);
    c=c.map(v=>Math.min(255,Math.round(v*(0.55+0.75*l))));
  }
  const o=(j*S+i)*3; px[o]=c[0];px[o+1]=c[1];px[o+2]=c[2];
}}
// mark named locations
for(const L of map.namedLocations){
  const i=Math.round((L.x+half)/W*S), j=Math.round((L.z+half)/W*S);
  const r=Math.max(3,Math.round(L.radius/W*S));
  for(let a=0;a<360;a+=2){const xx=i+Math.round(r*Math.cos(a*Math.PI/180)),yy=j+Math.round(r*Math.sin(a*Math.PI/180));
    if(xx>=0&&yy>=0&&xx<S&&yy<S){const o=(yy*S+xx)*3;px[o]=255;px[o+1]=255;px[o+2]=255;}}
  for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const xx=i+dx,yy=j+dy;if(xx>=0&&yy>=0&&xx<S&&yy<S){const o=(yy*S+xx)*3;px[o]=255;px[o+1]=60;px[o+2]=120;}}
}
let ppm=Buffer.concat([Buffer.from(`P6\n${S} ${S}\n255\n`),px]);
fs.writeFileSync('/tmp/map.ppm',ppm);
