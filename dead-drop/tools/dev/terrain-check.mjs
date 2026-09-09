import hf from '/home/user/FORTBLITZ/dead-drop/client/js/world/heightfield.js';
import map from '/home/user/FORTBLITZ/dead-drop/client/js/config/map.json' with {type:'json'};
let min=1e9,max=-1e9,land=0,water=0,n=0,steep=0;
const layers={};
for(let x=-2000;x<2000;x+=25)for(let z=-2000;z<2000;z+=25){
  const h=hf.getHeight(x,z);n++;min=Math.min(min,h);max=Math.max(max,h);
  if(h>0.5)land++;else water++;
  const s=hf.getSlope(x,z,2);if(s>40)steep++;
  const l=hf.getLayerIndex(x,z);layers[l]=(layers[l]||0)+1;
}
console.log('height range',min.toFixed(1),max.toFixed(1));
console.log('land%',(land/n*100).toFixed(1),'water%',(water/n*100).toFixed(1),'steep%',(steep/n*100).toFixed(1));
console.log('layers',JSON.stringify(layers));
console.log('--- named location ground check ---');
for(const l of map.namedLocations){
  const h=hf.getHeight(l.x,l.z), s=hf.getSlope(l.x,l.z,3);
  const flag=(l.isLake? h<3 : Math.abs(h-l.elevation)<12 && s<12)?'ok':'CHECK';
  console.log(l.name.padEnd(20), 'h='+h.toFixed(1).padStart(6), 'want='+l.elevation, 'slope='+s.toFixed(1).padStart(5), flag);
}
