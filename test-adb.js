const adb = require('./bridge/node_modules/adbkit');
const client = adb.createClient();

async function test(){
  const ip = '192.168.1.84:5555';
  console.log(`Connecting to ${ip} via adbkit...`);
  try{
    const id = await client.connect(ip, 5555);
    console.log('connect result:', id);
  }catch(e){ console.log('connect err', e.message); }

  // wait a bit
  await new Promise(r=>setTimeout(r,1500));
  const devices = await client.listDevices();
  console.log('devices:', devices);

  const dev = devices.find(d=> d.id.includes('192.168.1.84'));
  if(!dev){
    console.log('Device not found in list, trying 192.168.1.84:5555 id');
    // try with full id
  }
  const target = dev ? dev.id : '192.168.1.84:5555';
  console.log(`Trying keyevents on ${target} ...`);
  const keyMap = {left:21, right:22, up:19, down:20, center:23, ok:23};
  for(const k of ['left','right','up']){
    const code = keyMap[k];
    console.log(`→ Sending ${k} (${code}) ...`);
    try{
      const conn = await client.shell(target, `input keyevent ${code}`);
      // need to read the stream
      const output = await new Promise((res, rej)=>{
        let out='';
        conn.on('data', d=> out+=d);
        conn.on('end', ()=> res(out));
        conn.on('error', rej);
        setTimeout(()=> res(out||'(no output)'), 1500);
      });
      console.log(`  result: ${output||'ok'}`);
    }catch(e){ console.log(`  fail ${k}:`, e.message); }
    await new Promise(r=>setTimeout(r,800));
  }
  console.log('Done. Check TV screen for movement (left/right/up). If TV shows "Allow USB debugging?" please accept on TV and re-run.');
}
test().catch(e=> console.error(e));
