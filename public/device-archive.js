(() => {
  'use strict';
  const PREFIX = 'yijian-gomoku-local-history-v1';
  const DB_NAME = 'yijian-device-archive';
  const DB_STORE = 'handles';
  const HANDLE_KEY = 'shared-directory';
  const FOLDER_NAME = '弈间棋谱';
  let directory = null, busy = false, suppress = false, rerun = false, writeTimer = 0;
  const statusEl=document.getElementById('deviceArchiveStatus');
  const connectButton=document.getElementById('deviceArchiveConnect');
  const syncButton=document.getElementById('deviceArchiveSync');
  const exportButton=document.getElementById('deviceArchiveExport');
  const importButton=document.getElementById('deviceArchiveImport');
  const fileInput=document.getElementById('deviceArchiveFile');
  const historyButton=document.getElementById('historyButton');

  function status(message,kind='') {
    if(!statusEl)return;
    statusEl.textContent=message;
    statusEl.className='device-archive-status '+kind;
  }
  function openDb() {
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>req.result.createObjectStore(DB_STORE);
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error||new Error('无法保存文件夹授权'));
    });
  }
  async function idbGet(key) {
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readonly'),req=tx.objectStore(DB_STORE).get(key);
      req.onsuccess=()=>resolve(req.result||null);
      req.onerror=()=>reject(req.error);
      tx.oncomplete=()=>db.close();
    });
  }
  async function idbPut(key,value) {
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readwrite');
      tx.objectStore(DB_STORE).put(value,key);
      tx.oncomplete=()=>{db.close();resolve()};
      tx.onerror=()=>{const error=tx.error;db.close();reject(error)};
    });
  }
  async function permission(handle,ask=false) {
    let state=await handle.queryPermission({mode:'readwrite'});
    if(state!=='granted'&&ask)state=await handle.requestPermission({mode:'readwrite'});
    return state;
  }
  function ownerFromKey(key) {
    const prefix=PREFIX+':account:';
    if(key.startsWith(prefix)) {
      try{return decodeURIComponent(key.slice(prefix.length))}catch(_){return key.slice(prefix.length)}
    }
    return null;
  }
  function validRecord(r) {
    return !!r&&typeof r==='object'&&typeof r.id==='string'&&r.id.length>0&&Array.isArray(r.moves)&&r.moves.length<=225&&
      r.moves.every(m=>Array.isArray(m)&&m.length>=3&&Number.isInteger(m[0])&&m[0]>=0&&m[0]<15&&Number.isInteger(m[1])&&m[1]>=0&&m[1]<15&&(m[2]===1||m[2]===2));
  }
  function rowKey(row){return (row.owner||'')+'\u0000'+row.record.id}
  function uniqueRows(rows) {
    const seen=new Map();
    for(const row of rows) {
      if(!validRecord(row.record))continue;
      const key=rowKey(row),prior=seen.get(key);
      seen.set(key,prior?{...prior,record:{...prior.record,...row.record}}:row);
    }
    return [...seen.values()];
  }
  function localRows() {
    const rows=[];
    for(const key of Object.keys(localStorage)) {
      if(!key.startsWith(PREFIX+':'))continue;
      let owner;
      if(key===PREFIX+':guest')owner=null;
      else if(key.startsWith(PREFIX+':account:'))owner=ownerFromKey(key);
      else continue;
      try {
        const values=JSON.parse(localStorage.getItem(key)||'[]');
        if(Array.isArray(values))for(const record of values)if(validRecord(record))rows.push({owner,record});
      }catch(_){}
    }
    return uniqueRows(rows);
  }
  function safeName(value) {
    let a=2166136261,b=2246822519,c=3266489917,d=668265263;
    for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);a=Math.imul(a^n,16777619);b=Math.imul(b^n,3266489917);c=Math.imul(c^n,668265263);d=Math.imul(d^n,374761393)}
    return [a,b,c,d].map(n=>(n>>>0).toString(16).padStart(8,'0')).join('');
  }
  async function archiveDirectory(create=false) {
    if(!directory)throw new Error('请先选择共享文件夹');
    return directory.getDirectoryHandle(FOLDER_NAME,{create});
  }
  async function readArchive(folder) {
    const rows=[];
    for await(const [name,handle] of folder.entries()) {
      if(handle.kind!=='file'||!/^record-[a-f0-9]{32}\.json$/.test(name))continue;
      try {
        const file=await handle.getFile();
        if(file.size>1000000)continue;
        const data=JSON.parse(await file.text());
        if(data?.schema===1&&validRecord(data.record))rows.push({owner:typeof data.owner==='string'?data.owner:null,record:data.record});
      }catch(_){}
    }
    return uniqueRows(rows);
  }
  async function writeArchive(folder,rows) {
    let count=0;
    for(const row of uniqueRows(rows)) {
      const name='record-'+safeName(rowKey(row))+'.json';
      const handle=await folder.getFileHandle(name,{create:true});
      const writer=await handle.createWritable();
      await writer.write(JSON.stringify({schema:1,owner:row.owner,record:row.record}));
      await writer.close();
      count++;
    }
    return count;
  }
  function importRows(rows) {
    const groups=new Map();
    for(const row of uniqueRows(rows)) {
      const key=row.owner===null?PREFIX+':guest':PREFIX+':account:'+encodeURIComponent(row.owner);
      if(!groups.has(key)) {
        let existing=[];
        try{const parsed=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(parsed))existing=parsed.filter(validRecord)}catch(_){}
        groups.set(key,existing);
      }
      const group=groups.get(key),index=group.findIndex(item=>item.id===row.record.id);
      if(index<0)group.push(row.record);else group[index]={...group[index],...row.record};
    }
    suppress=true;
    try {
      for(const [key,records] of groups) {
        records.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
        localStorage.setItem(key,JSON.stringify(records));
      }
    } finally{suppress=false}
  }
  async function syncArchive(ask=false) {
    if(busy){rerun=true;return 0}
    if(!directory){status('未连接共享文件夹');return 0}
    busy=true;
    try {
      const granted=await permission(directory,ask);
      if(granted!=='granted'){status('请点“同步记录”并允许访问所选文件夹');return 0}
      const folder=await archiveDirectory(true),onDisk=await readArchive(folder);
      importRows(onDisk);
      const count=await writeArchive(folder,uniqueRows([...onDisk,...localRows()]));
      status('已同步 '+count+' 局 · 本机文件夹存档已连接','ready');
      return count;
    } catch(error) {
      status('同步失败：'+(error.message||'无法访问文件夹'),'error');
      return 0;
    } finally {
      busy=false;
      if(rerun){rerun=false;syncArchive(false)}
    }
  }
  function downloadBackup() {
    const data={schema:1,app:'yijian-gomoku',createdAt:new Date().toISOString(),records:localRows()};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='弈间棋谱备份-'+new Date().toISOString().slice(0,10)+'.json';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    status('已导出 '+data.records.length+' 局备份','ready');
  }
  async function importBackup(file) {
    if(!file||file.size>15000000)throw new Error('备份文件无效或超过 15 MB');
    const data=JSON.parse(await file.text());
    if(data?.schema!==1||!Array.isArray(data.records))throw new Error('无法识别这份弈间备份');
    const rows=uniqueRows(data.records.slice(0,10000).map(row=>({owner:typeof row?.owner==='string'?row.owner:null,record:row?.record})).filter(row=>validRecord(row.record)));
    importRows(rows);
    status('已导入 '+rows.length+' 局到当前浏览器','ready');
  }
  async function connectDirectory() {
    if(!('showDirectoryPicker'in window)){status('此浏览器不支持共享文件夹，请使用导出与导入备份');return}
    try {
      directory=await window.showDirectoryPicker({id:'yijian-gomoku-device-archive',mode:'readwrite'});
      await idbPut(HANDLE_KEY,directory);
      const count=await syncArchive(true);
      if(!count)status('文件夹已选中；如浏览器询问，请允许读写权限');
    }catch(error){if(error?.name!=='AbortError')status('无法连接文件夹：'+(error.message||'请重试'),'error')}
  }
  connectButton?.addEventListener('click',connectDirectory);
  syncButton?.addEventListener('click',()=>syncArchive(true));
  exportButton?.addEventListener('click',downloadBackup);
  importButton?.addEventListener('click',()=>fileInput?.click());
  fileInput?.addEventListener('change',async()=>{
    try{await importBackup(fileInput.files?.[0])}
    catch(error){status('导入失败：'+(error.message||'文件无法读取'),'error')}
    finally{fileInput.value=''}
  });
  if(historyButton) {
    let replay=false;
    historyButton.addEventListener('click',event=>{
      if(replay||!directory||busy)return;
      event.preventDefault();event.stopImmediatePropagation();
      syncArchive(false).finally(()=>{replay=true;historyButton.click();replay=false});
    },true);
  }
  const nativeSet=Storage.prototype.setItem;
  Storage.prototype.setItem=function(key,value) {
    nativeSet.call(this,key,value);
    if(this===localStorage&&!suppress&&directory&&typeof key==='string'&&key.startsWith(PREFIX+':')) {
      clearTimeout(writeTimer);
      writeTimer=setTimeout(()=>syncArchive(false),450);
    }
  };
  (async()=>{
    if(!window.showDirectoryPicker) {
      if(connectButton)connectButton.textContent='浏览器不支持选文件夹';
      status('此浏览器可用导出/导入备份；Chrome、Edge 支持共享文件夹');
    }
    try {
      directory=await idbGet(HANDLE_KEY);
      if(directory) {
        const granted=await permission(directory,false);
        if(granted==='granted') {
          if(connectButton)connectButton.textContent='更换共享文件夹';
          status('共享文件夹已连接 · 打开历史时自动同步','ready');
        } else status('文件夹已记住；点“同步记录”重新允许访问');
      }
    }catch(error){status('无法恢复文件夹授权：'+(error.message||'请重新选择'),'error')}
  })();
})();