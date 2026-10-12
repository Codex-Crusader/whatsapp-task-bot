// Manual check: node test/live-show-task.cjs <task id> -- the task row and its Google Calendar event.
const fs=require('fs');process.loadEnvFile(require('path').join(__dirname,'..','.env'));const {JWT}=require('google-auth-library');const D=require('better-sqlite3');
const db=new D(require('path').join(__dirname,'..','data','bot.db'),{readonly:true});const t=db.prepare('select id,title,status,event_id,event_gen,event_dirty from tasks where id=?').get(Number(process.argv[2]||1));
const k=JSON.parse(fs.readFileSync(process.env.GOOGLE_KEY_FILE,'utf8'));
const j=new JWT({email:k.client_email,key:k.private_key,scopes:['https://www.googleapis.com/auth/calendar.events']});
const u='https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(process.env.CALENDAR_ID)+'/events/';
console.log('db:', t);
if (!t.event_id) { console.log('no event'); process.exit(); }
j.request({url:u+t.event_id}).then(r=>console.log('google:', {summary:r.data.summary,status:r.data.status,start:r.data.start.dateTime||r.data.start.date,reminders:r.data.reminders}),e=>console.log('google:', e.response?.status));
