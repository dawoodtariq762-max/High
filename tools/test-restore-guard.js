const fs=require('fs'), path=require('path'), os=require('os');
const Database=require('better-sqlite3');
const backup=require('../backend/backup.js');
let pass=0,fail=0;
const ck=(n,c,d)=>{c?(pass++,console.log('  PASS  '+n+(d?'   ('+d+')':''))):(fail++,console.log('  FAIL  '+n+(d?' — '+d:'')));};

const W=fs.mkdtempSync(path.join(os.tmpdir(),'restore-guard-'));
process.env.BACKUP_DIR=W;

// stand-in for the real db handle: records whether the live DB would be replaced
let replaced=false, fullSnapshots=0;
const fakeDb={
  getDbFile:()=>path.join(W,'data.sqlite'),
  save:()=>{},
  exec:(sql)=>{ if(/VACUUM INTO/.test(sql)){ fullSnapshots++;
      const m=sql.match(/VACUUM INTO '([^']+)'/); fs.writeFileSync(m[1],'full-snapshot'); } },
  replaceWithFile:()=>{ replaced=true; },
  prepare:()=>{ throw new Error('prepare should not be called'); },
};
fs.writeFileSync(fakeDb.getDbFile(),'LIVE DATABASE');

// 1. make a reduced backup
const src=new Database('/tmp/qtech-fixture.sqlite',{readonly:true});
const src2=new Database(require('path').join(W,'rw.sqlite'));
src2.exec(`ATTACH DATABASE '${path.join(W,'rw.sqlite')}' AS x`); src2.close();
// build the reduced file against the fixture via a read-write copy
fs.copyFileSync('/tmp/qtech-fixture.sqlite', path.join(W,'src.sqlite'));
const rw=new Database(path.join(W,'src.sqlite'));
const b=backup.createBackup(rw,'guard-test');
rw.close();
const reducedFile=b.file;
console.log('  reduced backup: '+reducedFile);

// 2. attempt restore -> must refuse
let err=null;
try { backup.restoreBackup(fakeDb, reducedFile); } catch(e){ err=e; }
ck('restore of a reduced backup is REFUSED', !!err, err&&err.message.slice(0,90));
ck('live database NOT replaced', replaced===false);
ck('no full snapshot taken for a refused restore', fullSnapshots===0);
ck('live database file unchanged', fs.readFileSync(fakeDb.getDbFile(),'utf8')==='LIVE DATABASE');

// 3. a legacy FULL backup (no backup_meta) must still be restorable
const full=path.join(W,'qtech-sms-backup-2026-01-01T00-00-00-000Z.sqlite');
fs.writeFileSync(full,'FULL BACKUP CONTENT');
const info=backup.readBackupMeta(full);
ck('legacy backup without backup_meta is treated as full', info===null||info.format!=='reduced');
let err2=null;
try { backup.restoreBackup(fakeDb,'qtech-sms-backup-2026-01-01T00-00-00-000Z.sqlite'); } catch(e){ err2=e; }
ck('full backup restore proceeds', !err2, err2&&err2.message);
ck('live database WAS replaced for a full backup', replaced===true);
ck('a pre-restore FULL safety snapshot was taken', fullSnapshots===1, fullSnapshots+' snapshot(s)');

console.log('\n  '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
