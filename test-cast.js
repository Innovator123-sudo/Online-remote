const {Client, DefaultMediaReceiver} = require('./bridge/node_modules/castv2-client');

function testCast(ip){
  return new Promise((resolve)=>{
    const client = new Client();
    console.log(`Connecting to Cast ${ip}:8009 ...`);
    client.connect(ip, ()=>{
      console.log('Cast client connected');
      client.getStatus((err, status)=>{
        if(err){ console.log('getStatus err', err.message); client.close(); return resolve(false); }
        console.log('Status:', JSON.stringify(status, null, 2).slice(0,800));
        // Try to launch and control
        client.launch(DefaultMediaReceiver, (err, player)=>{
          if(err){ console.log('launch err', err.message); client.close(); return resolve(false); }
          console.log('Launched DefaultMediaReceiver');
          // Try to get player status and send a simple command
          player.getStatus((err, s)=>{
            console.log('Player status:', s ? JSON.stringify(s).slice(0,400) : err.message);
            // Try to send a DPAD-like command via media session? For Chromecast, we can try to send a key event via custom namespace
            // For now, just show we can connect and that left/right/up would be via Android TV remote, not Cast
            client.close();
            resolve(true);
          });
        });
      });
    });
    client.on('error', (err)=>{
      console.log('Cast error', err.message);
      resolve(false);
    });
    setTimeout(()=>{ console.log('Cast timeout'); try{client.close();}catch{}; resolve(false); }, 5000);
  });
}

testCast('192.168.1.84').then(ok=> console.log('Cast test done, ok=',ok));
